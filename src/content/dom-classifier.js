const CATEGORY_BY_TAG = Object.freeze({
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  P: "paragraph",
  LI: "list_item",
  BUTTON: "control",
  A: "link",
  LABEL: "label",
  SPAN: "inline"
});

export function classifyBlock(block) {
  const byTag = CATEGORY_BY_TAG[block.parentTag];
  if (byTag) {
    return byTag;
  }
  if (block.text.length < 30) {
    return "short_text";
  }
  if (block.text.length > 240) {
    return "long_text";
  }
  return "generic";
}

export function classifyBlocks(blocks) {
  return blocks.map((block) => ({
    ...block,
    category: classifyBlock(block)
  }));
}