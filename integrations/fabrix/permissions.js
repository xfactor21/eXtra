/* xPin fabriX adapter — permission model.
 *
 * Deny by default. Read and write are separately authorized groups; a write
 * grant is approved explicitly by the user in the settings panel and is
 * revocable at any time. Each group records its own grant (grantedAt,
 * grantedBy, reason, folder scope) — one group's grant never implies the
 * other's. No capability is available without its group grant, and the
 * adapter never enumerates the whole vault in one call.
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
    var record = fabrixState.grants && fabrixState.grants[group];
    return !!record && record.granted === true;
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
  // Scope is per group: the scope checked is the one on the capability's
  // own group, so a read scope never constrains a write call and vice versa.
  function groupScope(fabrixState, capability) {
    var group = groupOf(capability);
    if (group === null) return null;
    var record = fabrixState && fabrixState.grants && fabrixState.grants[group];
    if (!record || !record.scope || !Array.isArray(record.scope.folderIds)) return null;
    return record.scope.folderIds;
  }

  function inScope(fabrixState, folderId, capability) {
    var folderIds = groupScope(fabrixState, capability);
    if (folderIds === null || folderIds.length === 0) return true;
    if (folderId === null || folderId === undefined) return false;
    return folderIds.indexOf(folderId) !== -1;
  }

  function requireScope(fabrixState, folderId, capability) {
    if (!inScope(fabrixState, folderId, capability)) {
      throw FabrixError("permission_denied", "This folder is outside the granted scope.");
    }
  }

  // A scope failure on a note looked up by id must not leak existence: the
  // caller cannot tell an out-of-scope note from a missing one.
  function requireScopeOrNotFound(fabrixState, folderId, capability, id) {
    if (!inScope(fabrixState, folderId, capability)) {
      throw FabrixError("not_found", "No note with id " + id + ".");
    }
  }

  function cleanFolderIds(folderIds) {
    if (!Array.isArray(folderIds)) return [];
    return folderIds
      .filter(function (id) { return typeof id === "string" && id.length > 0; })
      .slice(0, 50)
      .map(function (id) { return id.slice(0, 120); });
  }

  function grant(fabrixState, group, options) {
    if (group !== "read" && group !== "write") {
      throw new TypeError("Grant group must be 'read' or 'write'.");
    }
    var opts = options && typeof options === "object" ? options : {};
    var next = JSON.parse(JSON.stringify(fabrixState));
    if (!next.grants || !next.grants[group] || typeof next.grants[group] !== "object") {
      next.grants[group] = { granted: false, grantedAt: "", grantedBy: "", reason: "", scope: { folderIds: [] } };
    }
    var record = next.grants[group];
    record.granted = true;
    record.grantedAt = new Date().toISOString();
    record.grantedBy = typeof opts.grantedBy === "string" && opts.grantedBy ? opts.grantedBy.slice(0, 40) : "user";
    if (typeof opts.reason === "string") record.reason = opts.reason.slice(0, 300);
    if (opts.folderIds !== undefined) record.scope = { folderIds: cleanFolderIds(opts.folderIds) };
    return next;
  }

  // Sets a group's folder scope without granting (or revoking) anything, so
  // the user can scope a grant before approving it in Settings.
  function setScope(fabrixState, group, folderIds) {
    if (group !== "read" && group !== "write") {
      throw new TypeError("Scope group must be 'read' or 'write'.");
    }
    var next = JSON.parse(JSON.stringify(fabrixState));
    if (!next.grants || !next.grants[group] || typeof next.grants[group] !== "object") {
      next.grants[group] = { granted: false, grantedAt: "", grantedBy: "", reason: "", scope: { folderIds: [] } };
    }
    next.grants[group].scope = { folderIds: cleanFolderIds(folderIds) };
    return next;
  }

  // Sets a group's approval reason without granting (or revoking) anything,
  // so the reason can be recorded before the grant is approved.
  function setReason(fabrixState, group, reason) {
    if (group !== "read" && group !== "write") {
      throw new TypeError("Reason group must be 'read' or 'write'.");
    }
    var next = JSON.parse(JSON.stringify(fabrixState));
    if (!next.grants || !next.grants[group] || typeof next.grants[group] !== "object") {
      next.grants[group] = { granted: false, grantedAt: "", grantedBy: "", reason: "", scope: { folderIds: [] } };
    }
    next.grants[group].reason = typeof reason === "string" ? reason.slice(0, 300) : "";
    return next;
  }

  function revoke(fabrixState, group) {
    var next = JSON.parse(JSON.stringify(fabrixState));
    if (group === "read" || group === "write") {
      if (next.grants && next.grants[group] && typeof next.grants[group] === "object") {
        next.grants[group].granted = false;
      } else if (next.grants) {
        next.grants[group] = false;
      }
    } else {
      ["read", "write"].forEach(function (g) {
        if (next.grants && next.grants[g] && typeof next.grants[g] === "object") {
          next.grants[g].granted = false;
        } else if (next.grants) {
          next.grants[g] = false;
        }
      });
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
    requireScopeOrNotFound: requireScopeOrNotFound,
    grant: grant,
    setScope: setScope,
    setReason: setReason,
    revoke: revoke
  });
})();
