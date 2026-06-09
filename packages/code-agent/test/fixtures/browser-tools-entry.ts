import { createCodingTools } from '../../src/tools/index.js';

const tools = createCodingTools({
  cwd: '/workspace',
});

export const toolNames = tools.map((tool) => tool.name);
