import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  async redirects() {
    return [
      {
        source: '/docs/getting-started',
        destination: '/docs/framework',
        permanent: false,
      },
      {
        source: '/docs/quickstart',
        destination: '/docs/framework',
        permanent: false,
      },
      {
        source: '/docs/framework/getting-started',
        destination: '/docs/framework',
        permanent: false,
      },
      {
        source: '/docs/framework/get-started',
        destination: '/docs/framework',
        permanent: false,
      },
      {
        source: '/docs/framework/quickstart',
        destination: '/docs/framework',
        permanent: false,
      },
      // Memory layers were renamed to context layers (and later renamed
      // again in the naming cutover). Point the old memory slugs straight at
      // the final pages so no redirect chain lands on a dead slug.
      {
        source: '/docs/framework/memory/working-memory',
        destination: '/docs/framework/context-layers/scratchpad',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/observational-memory',
        destination: '/docs/framework/context-layers/observations',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/temporal-memory',
        destination: '/docs/framework/context-layers/temporal',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/plan-memory',
        destination: '/docs/framework/context-layers/plan',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/tool-memory',
        destination: '/docs/framework/context-layers/tool-calls',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/episodic-memory',
        destination: '/docs/framework/context-layers/episodic-context',
        permanent: true,
      },
      {
        source: '/docs/framework/memory/:slug*',
        destination: '/docs/framework/context-layers/:slug*',
        permanent: true,
      },
      {
        source: '/docs/framework/api/memory-types',
        destination: '/docs/framework/api/context-layer-types',
        permanent: true,
      },
      // Naming cutover: step builders.
      {
        source: '/docs/framework/steps/run',
        destination: '/docs/framework/steps/run-code',
        permanent: true,
      },
      {
        source: '/docs/framework/steps/llm',
        destination: '/docs/framework/steps/call-model',
        permanent: true,
      },
      {
        source: '/docs/framework/steps/tool',
        destination: '/docs/framework/steps/invoke-tool',
        permanent: true,
      },
      // Naming cutover: operators.
      {
        source: '/docs/framework/operators/branch',
        destination: '/docs/framework/operators/conditional',
        permanent: true,
      },
      {
        source: '/docs/framework/operators/fork',
        destination: '/docs/framework/operators/in-parallel',
        permanent: true,
      },
      {
        source: '/docs/framework/operators/provide',
        destination: '/docs/framework/operators/with-context',
        permanent: true,
      },
      // Naming cutover: context layers.
      {
        source: '/docs/framework/context-layers/working-memory-context',
        destination: '/docs/framework/context-layers/scratchpad',
        permanent: true,
      },
      {
        source: '/docs/framework/context-layers/observational-context',
        destination: '/docs/framework/context-layers/observations',
        permanent: true,
      },
      {
        source: '/docs/framework/context-layers/temporal-context',
        destination: '/docs/framework/context-layers/temporal',
        permanent: true,
      },
      {
        source: '/docs/framework/context-layers/plan-context',
        destination: '/docs/framework/context-layers/plan',
        permanent: true,
      },
      {
        source: '/docs/framework/context-layers/history-window',
        destination: '/docs/framework/context-layers/history',
        permanent: true,
      },
      {
        source: '/docs/framework/context-layers/file-reference',
        destination: '/docs/framework/context-layers/filesystem',
        permanent: true,
      },
      {
        source: '/docs/framework/context-layers/static-content',
        destination: '/docs/framework/context-layers/instructions',
        permanent: true,
      },
      {
        source: '/docs/framework/context-layers/durable-task-state',
        destination: '/docs/framework/context-layers/task-state',
        permanent: true,
      },
      {
        source: '/docs/framework/context-layers/tool-context',
        destination: '/docs/framework/context-layers/tool-calls',
        permanent: true,
      },
      // Pattern docs were removed. dynamicWorkflow / parseAndRunWorkflow live
      // in the JSON workflow runtime page; everything else folds into the
      // framework overview.
      {
        source: '/docs/framework/patterns',
        destination: '/docs/framework/overview',
        permanent: true,
      },
      {
        source: '/docs/framework/patterns/:slug*',
        destination: '/docs/framework/overview',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
