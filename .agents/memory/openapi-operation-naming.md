---
name: OpenAPI operation naming
description: Codegen naming constraints for request bodies in the shared OpenAPI/Zod client.
---

When an OpenAPI component schema name matches the generated operation request-body export, the Zod package can emit duplicate exports and fail the workspace typecheck. Give the operation a distinct name from the component, such as using `replace` for the operation and reserving `rotate` for the input schema.

**Why:** Orval generates operation-level Zod validators and component-level TypeScript types into separate files that are both re-exported from the package entry point.

**How to apply:** If `pnpm --filter @workspace/api-spec run codegen` reports a duplicate export, inspect the operationId and referenced body schema names before editing generated output; rename the operationId in OpenAPI and regenerate.