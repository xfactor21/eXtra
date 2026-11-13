/* xPin fabriX adapter — permission model.
 *
 * Deny by default. Read and write are separately authorized groups; a write
 * grant is approved explicitly by the user in the settings panel and is
 * revocable at any time. No capability is available without its group grant,
 * and the adapter never enumerates the whole vault in one call.
 *
 * Capability -> risk group (from the manifest):
 *   read:  notes.search, notes.read, notes.export, projects.list
 *   write: notes.create, notes.update, artifacts.publish
 */
(function () {
  "use strict";

  var CAPABILITIES = Object.freeze({
    "notes.search": "read",
    "notes.read": "read",
    "notes.create": "write",
    "notes.update": "write",
    "notes.export": "read",
    "projects.list": "read",
    "artifacts.publish": "write"
  });

  function FabrixError(code, message) {
    var error = new Error(message);
    error.name = "FabrixError";
    error.code = code;
    return error;
  }

  function groupOf(capability) {
    return Object.prototype.hasOwnProperty.call(CAPABILITIES, capability)
      ? CAPABILITIES[capability]
      : null;
  }

  function isKnown(capability) {
    return groupOf(capability) !== null;
  }

  // The adapter must be enabled AND the capability's group granted.
  function hasGrant(fabrixState, capability) {
    if (!fabrixState || fabrixState.enabled !== true) return false;
    var group = groupOf(capability);
    if (group === null) return false;
    return fabrixState.grants && fabrixState.grants[group] === true;
  }

  function requireGrant(fabrixState, capability) {
    if (!fabrixState || fabrixState.enabled !== true) {
      throw FabrixError("permission_denied", "The fabriX integration is disabled.");
    }
    if (!isKnown(capability)) {
      throw FabrixError("capability_unknown", "Unknown capability: " + String(capability));
    }
    if (!hasGrant(fabrixState, capability)) {
      var group = groupOf(capability);
      throw FabrixError(
        "permission_denied",
        "The " + group + " permission for " + capability + " has not been granted. " +
        "Grant it in Settings → fabriX integration."
      );
    }
  }

  // Optional folder scoping: a grant may be limited to folder ids. An empty
  // scope list means workspace-wide (and the settings panel labels it so).
  function inScope(fabrixState, folderId) {
    if (!fabrixState || !fabrixState.grants || !fabrixState.grants.scope) return true;
    var folderIds = fabrixState.grants.scope.folderIds;
    if (!Array.isArray(folderIds) || folderIds.length === 0) return true;
    if (folderId === null || folderId === undefined) return false;
    return folderIds.indexOf(folderId) !== -1;
  }

  function requireScope(fabrixState, folderId) {
    if (!inScope(fabrixState, folderId)) {
      throw FabrixError("permission_denied", "This folder is outside the granted scope.");
    }
  }

  function grant(fabrixState, group) {
    if (group !== "read" && group !== "write") {
      throw new TypeError("Grant group must be 'read' or 'write'.");
    }
    var next = JSON.parse(JSON.stringify(fabrixState));
    next.grants[group] = true;
    next.grants.grantedAt = new Date().toISOString();
    return next;
  }

  function revoke(fabrixState, group) {
    var next = JSON.parse(JSON.stringify(fabrixState));
    if (group === "read" || group === "write") {
      next.grants[group] = false;
    } else {
      next.grants.read = false;
      next.grants.write = false;
    }
    return next;
  }

  window.xPinFabrixPermissions = Object.freeze({
    CAPABILITIES: CAPABILITIES,
    FabrixError: FabrixError,
    groupOf: groupOf,
    isKnown: isKnown,
    hasGrant: hasGrant,
    requireGrant: requireGrant,
    inScope: inScope,
    requireScope: requireScope,
    grant: grant,
    revoke: revoke
  });
})();
