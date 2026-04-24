# Known Issues

## @openrouter/agent SDK Compatibility Bug

**Status:** Workaround in place  
**Affected versions:** `@openrouter/agent@0.3.0`, `@openrouter/agent@0.3.1`  
**Upstream issue:** Needs to be filed on `@openrouter/agent` repository

### Problem

The `@openrouter/agent` package imports from a path that no longer exists in recent versions of `@openrouter/sdk`:

```javascript
// In @openrouter/agent/esm/lib/chat-compat.js
import { 
  EasyInputMessageRoleAssistant, 
  EasyInputMessageRoleDeveloper, 
  EasyInputMessageRoleSystem, 
  EasyInputMessageRoleUser 
} from '@openrouter/sdk/models/easyinputmessage';
```

The SDK renamed these exports with an `OpenResponses` prefix:
- `EasyInputMessageRoleAssistant` → `OpenResponsesEasyInputMessageRoleAssistant`
- `EasyInputMessageRoleDeveloper` → `OpenResponsesEasyInputMessageRoleDeveloper`
- `EasyInputMessageRoleSystem` → `OpenResponsesEasyInputMessageRoleSystem`
- `EasyInputMessageRoleUser` → `OpenResponsesEasyInputMessageRoleUser`

The module path also changed from `models/easyinputmessage` to `models/openresponseseasyinputmessage`.

### Error

```
Cannot find module '@openrouter/sdk/models/easyinputmessage'
```

### Workaround

A postinstall script (`scripts/patch-sdk.js`) creates a compatibility shim that re-exports the renamed types with their original names:

```javascript
// scripts/patch-sdk.js creates this shim at:
// node_modules/@openrouter/sdk/esm/models/easyinputmessage.js

export {
  OpenResponsesEasyInputMessageRoleAssistant as EasyInputMessageRoleAssistant,
  OpenResponsesEasyInputMessageRoleDeveloper as EasyInputMessageRoleDeveloper,
  OpenResponsesEasyInputMessageRoleSystem as EasyInputMessageRoleSystem,
  OpenResponsesEasyInputMessageRoleUser as EasyInputMessageRoleUser,
} from './openresponseseasyinputmessage.js';
```

### Resolution

This issue needs to be fixed upstream in `@openrouter/agent`. The fix would be to update the imports to use the new `OpenResponses`-prefixed names and the correct module path.

Once fixed upstream, we can remove:
1. The `postinstall` script in `package.json`
2. The `scripts/patch-sdk.js` file
3. This known issue entry
