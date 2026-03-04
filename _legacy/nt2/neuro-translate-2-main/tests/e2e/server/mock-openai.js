const http = require('http');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function collectUserText(input) {
  const rows = Array.isArray(input) ? input : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.role !== 'user' || !Array.isArray(row.content)) {
      continue;
    }
    for (let j = 0; j < row.content.length; j += 1) {
      const part = row.content[j];
      if (part && part.type === 'input_text' && typeof part.text === 'string') {
        return part.text;
      }
    }
  }
  return '';
}

function extractFunctionCallOutputs(input, callIndex) {
  const rows = Array.isArray(input) ? input : [];
  const out = [];
  rows.forEach((row) => {
    if (!row || row.type !== 'function_call_output' || typeof row.call_id !== 'string') {
      return;
    }
    const toolRef = callIndex.get(row.call_id) || null;
    out.push({
      callId: row.call_id,
      toolName: toolRef ? toolRef.toolName : null,
      output: safeJsonParse(typeof row.output === 'string' ? row.output : JSON.stringify(row.output || {}), null),
      rawOutput: row.output
    });
  });
  return out;
}

function createMockOpenAiServer({ host = '127.0.0.1', port = 0 } = {}) {
  let server = null;
  let listeningPort = null;
  const debugToolRouting = process.env.NT_E2E_DEBUG_TOOLS === '1';

  const stats = {
    totalRequests: 0,
    responsesRequests: 0,
    streamRequests: 0,
    nonStreamRequests: 0,
    toolRequests: 0,
    status429: 0,
    status5xx: 0,
    streamAborts: 0
  };
  const recentRequests = [];
  const MAX_RECENT_REQUESTS = 200;
  const callIndex = new Map();
  const responseOutputHistory = new Map();
  let responseSeq = 0;
  let callSeq = 0;
  let fail429Remaining = 0;
  let fail429RetryAfterMs = 1200;
  let fail5xxRemaining = 0;
  let fail5xxStatus = 503;
  let failStreamAbortRemaining = 0;
  let streamFirstByteDelayMs = 0;

  const nextResponseId = () => {
    responseSeq += 1;
    return `resp_mock_${responseSeq}`;
  };
  const nextCallId = () => {
    callSeq += 1;
    return `call_mock_${callSeq}`;
  };
  const pushRecent = (row) => {
    recentRequests.push({
      ts: Date.now(),
      ...(row && typeof row === 'object' ? row : {})
    });
    if (recentRequests.length > MAX_RECENT_REQUESTS) {
      recentRequests.splice(0, recentRequests.length - MAX_RECENT_REQUESTS);
    }
  };

  const rateHeaders = () => {
    const remainingRequests = Math.max(0, 500 - stats.responsesRequests);
    const remainingTokens = Math.max(0, 500000 - (stats.responsesRequests * 200));
    return {
      'x-request-id': `mock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      'x-ratelimit-limit-requests': '500',
      'x-ratelimit-remaining-requests': String(remainingRequests),
      'x-ratelimit-limit-tokens': '500000',
      'x-ratelimit-remaining-tokens': String(remainingTokens),
      'x-ratelimit-reset-requests': '1s',
      'x-ratelimit-reset-tokens': '1s'
    };
  };

  const baseHeaders = () => ({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST,GET,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-nt-token,x-nt-project-id'
  });

  const json = (res, status, payload, headers = {}) => {
    const body = JSON.stringify(payload || {});
    res.writeHead(status, {
      ...baseHeaders(),
      ...rateHeaders(),
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0'
    });
    res.end(body);
  };

  const registerCall = (toolName) => {
    const callId = nextCallId();
    callIndex.set(callId, {
      toolName: String(toolName || ''),
      ts: Date.now()
    });
    return callId;
  };

  const assistantOutput = ({ outputText = 'ok', responseId = null } = {}) => ({
    id: responseId || nextResponseId(),
    output_text: outputText,
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText }]
    }]
  });

  const functionCallOutput = ({ calls, responseId = null } = {}) => ({
    id: responseId || nextResponseId(),
    output_text: '',
    output: (Array.isArray(calls) ? calls : [])
      .map((row) => ({
        type: 'function_call',
        id: `fc_${Math.random().toString(16).slice(2, 10)}`,
        call_id: registerCall(row.name),
        name: row.name,
        arguments: JSON.stringify(row.arguments || {})
      }))
  });

  const mergeOutputs = (previous, current) => {
    const merged = [];
    const seen = new Set();
    const append = (row) => {
      if (!row || typeof row !== 'object') {
        return;
      }
      const callId = typeof row.callId === 'string' ? row.callId : '';
      const key = callId || `${String(row.toolName || '')}:${JSON.stringify(row.output || null)}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      merged.push(row);
    };
    (Array.isArray(previous) ? previous : []).forEach(append);
    (Array.isArray(current) ? current : []).forEach(append);
    return merged;
  };

  const buildPlanningCategories = (preanalysis) => {
    const byKey = {};
    const preCategories = preanalysis && Array.isArray(preanalysis.preCategories)
      ? preanalysis.preCategories
      : [];
    preCategories.forEach((row) => {
      const key = row && typeof row.key === 'string' ? row.key.trim().toLowerCase() : '';
      const count = Number.isFinite(Number(row && row.count)) ? Math.max(0, Math.round(Number(row.count))) : 0;
      if (key) {
        byKey[key] = count;
      }
    });
    const inferred = [];
    const consumedKeys = new Set();
    const pushUnique = (id, titleRu, descriptionRu, countUnits = 0) => {
      if (!id || inferred.some((row) => row.id === id)) {
        return;
      }
      inferred.push({ id, titleRu, descriptionRu, countUnits });
    };
    const addByMatch = (test, id, titleRu, descriptionRu) => {
      const keys = Object.keys(byKey);
      const matchedKeys = keys.filter((key) => test(key));
      matchedKeys.forEach((key) => consumedKeys.add(key));
      const matchedCount = matchedKeys.reduce((sum, key) => sum + Number(byKey[key] || 0), 0);
      if (matchedCount > 0) {
        pushUnique(id, titleRu, descriptionRu, matchedCount);
      }
    };
    addByMatch((key) => key.indexOf('head') >= 0 || key === 'h1' || key === 'h2' || key === 'h3', 'headings', 'Заголовки', 'Заголовки и подзаголовки');
    addByMatch((key) => key.indexOf('button') >= 0 || key.indexOf('input') >= 0 || key.indexOf('label') >= 0 || key.indexOf('form') >= 0, 'ui_controls', 'Элементы интерфейса', 'Кнопки, поля, подписи');
    addByMatch((key) => key.indexOf('nav') >= 0 || key.indexOf('menu') >= 0 || key.indexOf('breadcrumb') >= 0, 'navigation', 'Навигация', 'Меню и навигационные элементы');
    addByMatch((key) => key.indexOf('table') >= 0 || key.indexOf('cell') >= 0 || key.indexOf('tr') >= 0 || key.indexOf('td') >= 0, 'tables', 'Таблицы', 'Табличные данные');
    addByMatch((key) => key.indexOf('code') >= 0 || key.indexOf('pre') >= 0 || key.indexOf('kbd') >= 0, 'code', 'Код', 'Технические фрагменты и код');
    addByMatch((key) => key === 'unknown' || key.indexOf('unknown') >= 0, 'unknown', 'Неопределённые', 'Блоки без явной семантической категории');

    const totalBlocks = Number.isFinite(Number(preanalysis && preanalysis.stats && preanalysis.stats.blockCount))
      ? Math.max(0, Math.round(Number(preanalysis.stats.blockCount)))
      : 0;
    const knownTotal = inferred.reduce((sum, row) => sum + Number(row.countUnits || 0), 0);
    const mainCount = Math.max(1, totalBlocks > knownTotal ? totalBlocks - knownTotal : Math.max(1, totalBlocks));
    pushUnique('main_content', 'Основной текст', 'Основной контент страницы', mainCount);
    const residualUnknown = Object.keys(byKey)
      .filter((key) => !consumedKeys.has(key))
      .reduce((sum, key) => sum + Number(byKey[key] || 0), 0);
    // Planning runtime expects that "unknown" can be explicitly selected by user.
    // Keep it always available, even if pre-analysis could not infer a positive count.
    pushUnique(
      'unknown',
      'Неопределённые',
      'Блоки без явной семантической категории',
      residualUnknown > 0 ? residualUnknown : 1
    );
    return inferred;
  };

  const planningResponse = (outputs) => {
    const tracePlanning = (step, extra) => {
      if (!debugToolRouting) {
        return;
      }
      // eslint-disable-next-line no-console
      console.log('[mock-openai] planning-step', step, extra || '');
    };
    const hasTool = (name) => outputs.some((row) => row.toolName === name);
    const lastToolOutput = (name) => {
      for (let i = outputs.length - 1; i >= 0; i -= 1) {
        const row = outputs[i];
        if (row && row.toolName === name) {
          return row.output || null;
        }
      }
      return null;
    };
    if (!hasTool('page.get_preanalysis')) {
      tracePlanning('request_preanalysis');
      return functionCallOutput({
        calls: [
          {
            name: 'page.get_preanalysis',
            arguments: {}
          }
        ]
      });
    }

    const preanalysis = lastToolOutput('page.get_preanalysis');
    const categories = buildPlanningCategories(preanalysis);
    const categoryIds = categories.map((row) => row.id);
    const categorySet = new Set(categoryIds);
    const normalizeCategoryFromPreKey = (preKey) => {
      const key = String(preKey || '').trim().toLowerCase();
      if (!key) {
        return categorySet.has('main_content') ? 'main_content' : categoryIds[0];
      }
      if (key === 'unknown' || key.indexOf('unknown') >= 0) {
        return categorySet.has('unknown') ? 'unknown' : (categorySet.has('main_content') ? 'main_content' : categoryIds[0]);
      }
      if (key.indexOf('head') >= 0 || key === 'h1' || key === 'h2' || key === 'h3') {
        return categorySet.has('headings') ? 'headings' : (categorySet.has('main_content') ? 'main_content' : categoryIds[0]);
      }
      if (key.indexOf('button') >= 0 || key.indexOf('input') >= 0 || key.indexOf('label') >= 0 || key.indexOf('form') >= 0) {
        return categorySet.has('ui_controls') ? 'ui_controls' : (categorySet.has('main_content') ? 'main_content' : categoryIds[0]);
      }
      if (key.indexOf('nav') >= 0 || key.indexOf('menu') >= 0 || key.indexOf('breadcrumb') >= 0) {
        return categorySet.has('navigation') ? 'navigation' : (categorySet.has('main_content') ? 'main_content' : categoryIds[0]);
      }
      if (key.indexOf('table') >= 0 || key.indexOf('cell') >= 0 || key.indexOf('tr') >= 0 || key.indexOf('td') >= 0) {
        return categorySet.has('tables') ? 'tables' : (categorySet.has('main_content') ? 'main_content' : categoryIds[0]);
      }
      if (key.indexOf('code') >= 0 || key.indexOf('pre') >= 0 || key.indexOf('kbd') >= 0) {
        return categorySet.has('code') ? 'code' : (categorySet.has('main_content') ? 'main_content' : categoryIds[0]);
      }
      return categorySet.has('main_content') ? 'main_content' : (categorySet.has('unknown') ? 'unknown' : categoryIds[0]);
    };
    const taxonomyBlockToCategory = {};
    const sampleBlocks = preanalysis && Array.isArray(preanalysis.sampleBlocks)
      ? preanalysis.sampleBlocks
      : [];
    sampleBlocks.forEach((row) => {
      const blockId = row && typeof row.blockId === 'string' ? row.blockId.trim() : '';
      if (!blockId) {
        return;
      }
      taxonomyBlockToCategory[blockId] = normalizeCategoryFromPreKey(row.preCategory);
    });
    const modelRouting = {};
    const batching = {};
    const context = {};
    const qc = {};
    categoryIds.forEach((id) => {
      modelRouting[id] = {
        route: id === 'code' ? 'strong' : 'auto',
        model: 'auto',
        style: id === 'code' ? 'technical' : 'balanced'
      };
      batching[id] = {
        unit: 'block',
        mode: 'mixed',
        maxUnitsPerBatch: 'auto',
        keepHistory: 'auto'
      };
      context[id] = {
        buildGlobalContext: 'auto',
        buildGlossary: 'auto',
        useCategoryJoinedContext: 'auto'
      };
      qc[id] = {
        proofreadingPasses: 'auto',
        qualityBar: 'medium'
      };
    });

    if (!hasTool('agent.plan.set_taxonomy') || !hasTool('agent.plan.set_pipeline')) {
      tracePlanning('set_taxonomy_and_pipeline', {
        categories: categoryIds.slice(0, 12),
        mappedBlocks: Object.keys(taxonomyBlockToCategory).length
      });
      return functionCallOutput({
        calls: [
          {
            name: 'agent.plan.set_taxonomy',
            arguments: {
              categories: categories.map((row) => ({
                id: row.id,
                titleRu: row.titleRu,
                descriptionRu: row.descriptionRu,
                criteriaRu: `Контент типа ${row.id}`,
                defaultTranslate: row.id === 'main_content' || row.id === 'headings'
              })),
              mapping: {
                blockToCategory: taxonomyBlockToCategory,
                rangeToCategory: {}
              }
            }
          },
          {
            name: 'agent.plan.set_pipeline',
            arguments: {
              modelRouting,
              batching,
              context,
              qc
            }
          },
          {
            name: 'agent.plan.request_finish_analysis',
            arguments: {
              reason: 'taxonomy and pipeline prepared'
            }
          }
        ]
      });
    }

    const finish = lastToolOutput('agent.plan.request_finish_analysis');
    if (!finish || finish.ok !== true) {
      tracePlanning('request_finish_retry', {
        finishOk: finish && finish.ok === true,
        missing: finish && Array.isArray(finish.missing) ? finish.missing.slice(0, 12) : []
      });
      return functionCallOutput({
        calls: [
          {
            name: 'agent.plan.request_finish_analysis',
            arguments: {
              reason: 'retry validation'
            }
          }
        ]
      });
    }

    if (!hasTool('agent.ui.ask_user_categories')) {
      const defaults = categories
        .filter((row) => row.id === 'main_content' || row.id === 'headings')
        .map((row) => row.id);
      tracePlanning('ask_user_categories', {
        count: categories.length,
        defaults: defaults.length ? defaults : categoryIds.slice(0, 1)
      });
      return functionCallOutput({
        calls: [
          {
            name: 'agent.ui.ask_user_categories',
            arguments: {
              questionRu: 'Какие категории переводить сейчас?',
              categories: categories.map((row) => ({
                id: row.id,
                titleRu: row.titleRu,
                descriptionRu: row.descriptionRu,
                countUnits: row.countUnits
              })),
              defaults: defaults.length ? defaults : categoryIds.slice(0, 1)
            }
          }
        ]
      });
    }

    tracePlanning('planning_done');
    return assistantOutput({ outputText: 'planning_done' });
  };

  const executionResponse = (outputs) => {
    if (!outputs.length) {
      return functionCallOutput({
        calls: [{ name: 'job.get_next_units', arguments: { limit: 1, prefer: 'auto' } }]
      });
    }
    const last = outputs[outputs.length - 1];
    if (last.toolName === 'job.get_next_units') {
      const rows = last.output && Array.isArray(last.output.units) ? last.output.units : [];
      const first = rows.length ? rows[0] : null;
      if (!first || !first.id) {
        return assistantOutput({ outputText: 'execution_idle' });
      }
      return functionCallOutput({
        calls: [{
          name: 'translator.translate_unit_stream',
          arguments: {
            unitType: first.unitType || 'block',
            id: first.id,
            blockIds: Array.isArray(first.blockIds) ? first.blockIds : [],
            categoryId: first.categoryId || null,
            style: 'balanced'
          }
        }]
      });
    }
    if (last.toolName === 'translator.translate_unit_stream') {
      const rows = last.output && Array.isArray(last.output.results) ? last.output.results : [];
      const first = rows.length ? rows[0] : null;
      if (!first || !first.blockId) {
        return functionCallOutput({
          calls: [{ name: 'job.get_next_units', arguments: { limit: 1, prefer: 'auto' } }]
        });
      }
      return functionCallOutput({
        calls: [{
          name: 'job.mark_block_done',
          arguments: {
            blockId: first.blockId,
            text: typeof first.text === 'string' && first.text ? first.text : `[RU] ${first.blockId}`
          }
        }]
      });
    }
    if (last.toolName === 'job.get_next_blocks') {
      const rows = last.output && Array.isArray(last.output.blocks) ? last.output.blocks : [];
      const first = rows.length ? rows[0] : null;
      if (!first || !first.blockId) {
        return assistantOutput({ outputText: 'execution_idle' });
      }
      return functionCallOutput({
        calls: [{
          name: 'translator.translate_block_stream',
          arguments: { blockId: first.blockId, style: 'balanced' }
        }]
      });
    }
    if (last.toolName === 'translator.translate_block_stream') {
      const blockId = last.output && typeof last.output.blockId === 'string' ? last.output.blockId : null;
      const text = last.output && typeof last.output.text === 'string' ? last.output.text : '';
      if (!blockId) {
        return functionCallOutput({
          calls: [{ name: 'job.get_next_units', arguments: { limit: 1, prefer: 'auto' } }]
        });
      }
      return functionCallOutput({
        calls: [{ name: 'job.mark_block_done', arguments: { blockId, text: text || `[RU] ${blockId}` } }]
      });
    }
    if (last.toolName === 'job.mark_block_done' || last.toolName === 'job.mark_block_failed') {
      return functionCallOutput({
        calls: [{ name: 'job.get_next_units', arguments: { limit: 1, prefer: 'auto' } }]
      });
    }
    return functionCallOutput({
      calls: [{ name: 'job.get_next_units', arguments: { limit: 1, prefer: 'auto' } }]
    });
  };

  const proofreadingResponse = (outputs) => {
    if (!outputs.length) {
      return functionCallOutput({
        calls: [{ name: 'proof.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
      });
    }
    const last = outputs[outputs.length - 1];
    if (last.toolName === 'proof.get_next_blocks') {
      const rows = last.output && Array.isArray(last.output.blocks) ? last.output.blocks : [];
      const first = rows.length ? rows[0] : null;
      if (!first || !first.blockId) {
        return functionCallOutput({
          calls: [{ name: 'proof.finish', arguments: { reason: 'mock_empty_pending' } }]
        });
      }
      return functionCallOutput({
        calls: [{
          name: 'proof.proofread_block_stream',
          arguments: {
            blockId: first.blockId,
            mode: 'proofread',
            style: 'balanced',
            strictness: 'normal'
          }
        }]
      });
    }
    if (last.toolName === 'proof.proofread_block_stream') {
      const blockId = last.output && typeof last.output.blockId === 'string' ? last.output.blockId : null;
      const text = last.output && typeof last.output.text === 'string' ? last.output.text : '';
      if (!blockId) {
        return functionCallOutput({
          calls: [{ name: 'proof.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
        });
      }
      return functionCallOutput({
        calls: [{
          name: 'proof.mark_block_done',
          arguments: {
            blockId,
            text: text || `[RU-proofread] ${blockId}`,
            qualityTag: 'proofread'
          }
        }]
      });
    }
    if (last.toolName === 'proof.mark_block_done' || last.toolName === 'proof.mark_block_failed') {
      return functionCallOutput({
        calls: [{ name: 'proof.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
      });
    }
    if (last.toolName === 'proof.finish') {
      return assistantOutput({ outputText: 'proofreading_done' });
    }
    return functionCallOutput({
      calls: [{ name: 'proof.get_next_blocks', arguments: { limit: 1, prefer: 'dom_order' } }]
    });
  };

  const pickToolModeResponse = (body, outputs) => {
    const normalizeToolName = (value) => String(value || '').trim().toLowerCase().replace(/_/g, '.');
    const toolNames = new Set((Array.isArray(body.tools) ? body.tools : [])
      .map((row) => normalizeToolName(row && typeof row.name === 'string' ? row.name : ''))
      .filter(Boolean));
    const outputToolNames = Array.isArray(outputs)
      ? outputs
        .map((row) => normalizeToolName(row && typeof row.toolName === 'string' ? row.toolName : ''))
        .filter(Boolean)
      : [];
    const hasOutputTool = (prefix) => outputToolNames.some((name) => name.indexOf(prefix) === 0);
    const hasOutputExecution = outputToolNames.some((name) => (
      name === 'job.get.next.units'
      || name === 'job.get.next.blocks'
      || name === 'translator.translate.unit.stream'
      || name === 'translator.translate.block.stream'
      || name === 'job.mark.block.done'
      || name === 'job.mark.block.failed'
    ));
    const hasPlanningTools = (
      toolNames.has('agent.plan.set.taxonomy')
      && toolNames.has('agent.plan.set.pipeline')
      && toolNames.has('agent.plan.request.finish.analysis')
      && toolNames.has('agent.ui.ask.user.categories')
    );
    if (hasOutputTool('proof.')) {
      if (debugToolRouting) {
        // eslint-disable-next-line no-console
        console.log('[mock-openai] mode=proofreading by output', outputToolNames.slice(-3));
      }
      return proofreadingResponse(outputs);
    }
    if (hasOutputExecution) {
      if (debugToolRouting) {
        // eslint-disable-next-line no-console
        console.log('[mock-openai] mode=execution by output', outputToolNames.slice(-3));
      }
      return executionResponse(outputs);
    }
    if (hasPlanningTools) {
      if (debugToolRouting) {
        // eslint-disable-next-line no-console
        console.log('[mock-openai] mode=planning by tools', Array.from(toolNames).slice(0, 12));
      }
      return planningResponse(outputs);
    }
    if (toolNames.has('proof.get.next.blocks') && toolNames.has('proof.proofread.block.stream')) {
      if (debugToolRouting) {
        // eslint-disable-next-line no-console
        console.log('[mock-openai] mode=proofreading by manifest');
      }
      return proofreadingResponse(outputs);
    }
    if (toolNames.has('job.get.next.units') && toolNames.has('translator.translate.unit.stream')) {
      if (debugToolRouting) {
        // eslint-disable-next-line no-console
        console.log('[mock-openai] mode=execution by manifest (units)');
      }
      return executionResponse(outputs);
    }
    if (toolNames.has('job.get.next.blocks') && toolNames.has('translator.translate.block.stream')) {
      if (debugToolRouting) {
        // eslint-disable-next-line no-console
        console.log('[mock-openai] mode=execution by manifest (blocks)');
      }
      return executionResponse(outputs);
    }
    if (debugToolRouting) {
      // eslint-disable-next-line no-console
      console.log('[mock-openai] mode=ack fallback', {
        tools: Array.from(toolNames).slice(0, 12),
        outputTools: outputToolNames.slice(-3)
      });
    }
    return assistantOutput({ outputText: 'mock_tool_ack' });
  };

  const streamTranslation = async (res, body, { abortAfterFirstChunk = false, firstByteDelayMs = 0 } = {}) => {
    const sourceText = collectUserText(body.input) || '';
    const compact = sourceText.replace(/\s+/g, ' ').trim();
    const translated = `RU: ${compact || 'ok'}`;
    const chunkSize = Math.max(8, Math.ceil(translated.length / 3));
    const chunks = [];
    for (let i = 0; i < translated.length; i += chunkSize) {
      chunks.push(translated.slice(i, i + chunkSize));
    }
    const responseId = nextResponseId();
    res.writeHead(200, {
      ...baseHeaders(),
      ...rateHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'cache-control': 'no-cache, no-transform'
    });
    if (Number.isFinite(Number(firstByteDelayMs)) && Number(firstByteDelayMs) > 0) {
      await delay(Math.max(0, Math.round(Number(firstByteDelayMs))));
    }
    for (let i = 0; i < chunks.length; i += 1) {
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: chunks[i] })}\n\n`);
      if (abortAfterFirstChunk && i === 0) {
        stats.streamAborts += 1;
        await delay(60);
        try {
          res.destroy(new Error('mock_stream_abort'));
        } catch (_) {
          // noop
        }
        return;
      }
      await delay(220);
    }
    res.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: responseId,
        output_text: translated,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: translated }] }]
      }
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const handle = async (req, res) => {
    stats.totalRequests += 1;
    const url = req.url ? req.url.split('?')[0] : '/';
    if (req.method === 'OPTIONS') {
      pushRecent({ method: req.method, url, status: 204 });
      res.writeHead(204, baseHeaders());
      res.end();
      return;
    }
    if (req.method === 'GET' && url === '/v1/models') {
      pushRecent({ method: req.method, url, status: 200, kind: 'models' });
      json(res, 200, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4.1-mini' }] });
      return;
    }
    if (req.method !== 'POST' || url !== '/v1/responses') {
      pushRecent({ method: req.method, url, status: 404, kind: 'not_found' });
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      return;
    }
    stats.responsesRequests += 1;
    const bodyText = await new Promise((resolve) => {
      let buffer = '';
      req.on('data', (chunk) => { buffer += String(chunk || ''); });
      req.on('end', () => resolve(buffer));
      req.on('error', () => resolve(''));
    });
    const body = safeJsonParse(bodyText, {});
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (fail429Remaining > 0) {
      fail429Remaining -= 1;
      stats.status429 += 1;
      pushRecent({
        method: req.method,
        url,
        status: 429,
        kind: 'forced_429',
        stream: body.stream === true,
        hasTools
      });
      json(res, 429, { error: { code: 'rate_limit_exceeded', message: 'mock_429' } }, {
        'retry-after-ms': String(Math.max(200, Math.round(fail429RetryAfterMs))),
        'retry-after': String(Math.max(1, Math.ceil(fail429RetryAfterMs / 1000)))
      });
      return;
    }
    if (fail5xxRemaining > 0) {
      fail5xxRemaining -= 1;
      stats.status5xx += 1;
      const statusCode = Number.isFinite(Number(fail5xxStatus))
        ? Math.max(500, Math.min(599, Math.round(Number(fail5xxStatus))))
        : 503;
      pushRecent({
        method: req.method,
        url,
        status: statusCode,
        kind: 'forced_5xx',
        stream: body.stream === true,
        hasTools
      });
      json(res, statusCode, { error: { code: 'mock_5xx', message: `mock_${statusCode}` } });
      return;
    }
    if (hasTools) {
      stats.toolRequests += 1;
    }
    if (body.stream === true) {
      stats.streamRequests += 1;
      const shouldAbortStream = failStreamAbortRemaining > 0;
      if (shouldAbortStream) {
        failStreamAbortRemaining -= 1;
      }
      const delayFirstByteMs = Number.isFinite(Number(streamFirstByteDelayMs))
        ? Math.max(0, Math.round(Number(streamFirstByteDelayMs)))
        : 0;
      pushRecent({
        method: req.method,
        url,
        status: 200,
        kind: 'responses_stream',
        stream: true,
        abortAfterFirstChunk: shouldAbortStream,
        firstByteDelayMs: delayFirstByteMs,
        hasTools,
        previousResponseId: typeof body.previous_response_id === 'string' ? body.previous_response_id : null,
        inputItems: Array.isArray(body.input) ? body.input.length : 0
      });
      await streamTranslation(res, body, {
        abortAfterFirstChunk: shouldAbortStream,
        firstByteDelayMs: delayFirstByteMs
      });
      return;
    }
    stats.nonStreamRequests += 1;
    const outputs = extractFunctionCallOutputs(body.input, callIndex);
    const previousResponseId = typeof body.previous_response_id === 'string' ? body.previous_response_id : null;
    const previousOutputs = previousResponseId && responseOutputHistory.has(previousResponseId)
      ? responseOutputHistory.get(previousResponseId)
      : [];
    const mergedOutputs = mergeOutputs(previousOutputs, outputs);
    if (debugToolRouting) {
      // eslint-disable-next-line no-console
      console.log('[mock-openai] request', {
        previousResponseId,
        inputItems: Array.isArray(body.input) ? body.input.length : 0,
        outputItems: outputs.length,
        mergedOutputItems: mergedOutputs.length,
        outputTools: outputs.map((row) => row.toolName).filter(Boolean).slice(-6),
        outputSummary: outputs.map((row) => ({
          tool: row.toolName,
          ok: row && row.output && row.output.ok,
          missing: row && row.output && Array.isArray(row.output.missing) ? row.output.missing.slice(0, 6) : undefined
        })).slice(-6)
      });
    }
    pushRecent({
      method: req.method,
      url,
      status: 200,
      kind: 'responses',
      stream: false,
      hasTools,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      outputItems: outputs.length,
      previousResponseId,
      inputItems: Array.isArray(body.input) ? body.input.length : 0
    });
    const response = hasTools
      ? pickToolModeResponse(body, mergedOutputs)
      : assistantOutput({ outputText: body && body.input ? '.' : 'ok' });
    if (response && typeof response.id === 'string') {
      responseOutputHistory.set(response.id, mergedOutputs);
      if (responseOutputHistory.size > 200) {
        const oldest = responseOutputHistory.keys().next();
        if (!oldest.done) {
          responseOutputHistory.delete(oldest.value);
        }
      }
    }
    json(res, 200, response);
  };

  return {
    async start() {
      if (server) {
        return this;
      }
      server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          json(res, 500, { error: { code: 'MOCK_SERVER_ERROR', message: error && error.message ? error.message : 'mock failure' } });
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      listeningPort = addr && typeof addr.port === 'number' ? addr.port : null;
      return this;
    },

    async stop() {
      if (!server) {
        return;
      }
      const current = server;
      server = null;
      listeningPort = null;
      await new Promise((resolve) => current.close(() => resolve()));
    },

    resetStats() {
      Object.keys(stats).forEach((key) => { stats[key] = 0; });
      recentRequests.splice(0, recentRequests.length);
      callIndex.clear();
      responseOutputHistory.clear();
      responseSeq = 0;
      callSeq = 0;
      fail429Remaining = 0;
      fail429RetryAfterMs = 1200;
      fail5xxRemaining = 0;
      fail5xxStatus = 503;
      failStreamAbortRemaining = 0;
      streamFirstByteDelayMs = 0;
    },

    getStats() {
      return { ...stats };
    },

    getRecentRequests(limit = 60) {
      const max = Math.max(1, Math.min(200, Math.round(Number(limit) || 60)));
      return recentRequests.slice(-max).map((row) => ({ ...row }));
    },

    set429Sequence({ count = 1, retryAfterMs = 1200 } = {}) {
      fail429Remaining = Math.max(0, Math.round(Number(count) || 0));
      fail429RetryAfterMs = Math.max(200, Math.round(Number(retryAfterMs) || 1200));
    },

    set5xxSequence({ count = 1, status = 503 } = {}) {
      fail5xxRemaining = Math.max(0, Math.round(Number(count) || 0));
      fail5xxStatus = Number.isFinite(Number(status))
        ? Math.max(500, Math.min(599, Math.round(Number(status))))
        : 503;
    },

    setStreamFaults({ abortCount = 0, firstByteDelayMs = 0 } = {}) {
      failStreamAbortRemaining = Math.max(0, Math.round(Number(abortCount) || 0));
      streamFirstByteDelayMs = Number.isFinite(Number(firstByteDelayMs))
        ? Math.max(0, Math.min(120000, Math.round(Number(firstByteDelayMs))))
        : 0;
    },

    setFaultInjection({
      status429Count = 0,
      retryAfterMs = 1200,
      status5xxCount = 0,
      status5xxCode = 503,
      streamAbortCount = 0,
      streamFirstByteDelayMs = 0
    } = {}) {
      this.set429Sequence({ count: status429Count, retryAfterMs });
      this.set5xxSequence({ count: status5xxCount, status: status5xxCode });
      this.setStreamFaults({ abortCount: streamAbortCount, firstByteDelayMs: streamFirstByteDelayMs });
    },

    get origin() {
      return listeningPort ? `http://${host}:${listeningPort}` : null;
    }
  };
}

module.exports = {
  createMockOpenAiServer
};
