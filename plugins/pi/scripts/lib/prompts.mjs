import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const filePath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(filePath, "utf8");
}

export function interpolateTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in vars ? String(vars[key] ?? "") : match;
  });
}
