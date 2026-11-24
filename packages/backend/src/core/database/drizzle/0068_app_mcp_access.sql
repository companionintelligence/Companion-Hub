-- Whether a person let this app use the Hub's MCP tools on the apps beside it, and at what level.
-- A manifest asks with `hub_integration.mcp_client`; the Hub mints the app's MCP key only once a
-- person with the right to manage the Hub has answered here. NULL: nobody has been asked (an app
-- installed before this column, or one installed by a key). 'none': asked, and refused.
-- 'read' | 'write' | 'full': the level the key was granted at. Only a person's session writes it,
-- never the app's own key, which may otherwise change its own app.
ALTER TABLE "app" ADD COLUMN IF NOT EXISTS "mcp_access" varchar;
