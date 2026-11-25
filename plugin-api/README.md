# @newses/plugin-api

The contract [Newses](https://newses.app) server plugins are written against, and a test kit for them. The [plugin author guide](https://newses.app/guide/plugin-authors) covers hooks, the context, limits, testing, publishing, and installing; [newses-plugin-template](https://github.com/newses-app/newses-plugin-template) is a repository to start from.

```sh
npm install --save-dev @newses/plugin-api zod @types/node
```

List `@newses/plugin-api` and `zod` as peer dependencies too: the server provides both, and a plugin that brings its own `zod` is refused.

```ts
import { definePlugin } from '@newses/plugin-api';

export default definePlugin({
  id: 'hello',
  version: '1.0.0',
  apiVersion: '^0.1',
  scopes: ['user'],
  hooks: {
    'published.changed': {
      debounceSeconds: 120,
      run: (event, context) => {
        context.logger.info('published feed changed', { added: event.published.length });
      },
    },
  },
});
```

Tests run hooks as the server does with `@newses/plugin-api/testing`: `runHook`, `runTest`, `runAction`, `createTestContext`, `MemoryStore`, and fixture entries.

The API is 0.x: a minor release may break plugins, which declare the minor they were written for (`apiVersion: '^0.1'`). Licensed under the AGPL 3.0 or later, as Newses is.
