/* xPin fabriX adapter — domain helpers (pure, no app state).
 *
 * Input validation and payload shaping shared by the capability handlers.
 * The actual data access lives in the `FabrixDomain` object built by app.js
 * (createFabrixDomain) and handed to the adapter via attachDomain(); this
 * file never touches xPin's `state` directly.
 *
 * Validation style mirrors the app's own sanitizers: id patterns, length
 * caps, type checks. The credential-shaped-field list mirrors the Cloud
 * Bridge protocol's `payloadContainsSecret` (cloudprotocol/types.go).
 */
(function () {
  "use strict";

  // Keys are stored normalized: lowercase with _ and - stripped, so
  // camelCase variants (accessToken, clientSecret, refreshToken, privateKey)
  // match the same entries as their snake_case forms. Mirrors the Cloud
  // Bridge protocol's `payloadContainsSecret` (cloudprotocol/types.go).
  var SECRET_KEYS = [
    "token", "accesstoken", "refreshtoken", "apikey", "secret",
    "clientsecret", "password", "authorization", "cookie", "credential",
    "credentials", "privatekey"
  ];

  var MAX_TITLE = 120;
  var MAX_BODY = 100000;
  var MAX_QUERY = 500;
  var MAX_LIMIT = 100;

  function FabrixError(code, message) {
    var error = new Error(message);
    error.name = "FabrixError";
    error.code = code;
    return error;
  }

  function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[_-]/g, "").trim();
  }

  function isSecretKey(key) {
    return SECRET_KEYS.indexOf(normalizeKey(key)) !== -1;
  }

  // Mirrors cloudprotocol.payloadContainsSecret: any credential-shaped key,
  // at any depth, or nesting deeper than 10 levels, rejects the payload.
  function hasCredentialField(value, depth) {
    var level = depth == null ? 0 : depth;
    if (level > 10) return true;
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) {
          if (hasCredentialField(value[i], level + 1)) return true;
        }
        return false;
      }
      var keys = Object.keys(value);
      for (var j = 0; j < keys.length; j++) {
        if (isSecretKey(keys[j])) return true;
        if (hasCredentialField(value[keys[j]], level + 1)) return true;
      }
    }
    return false;
  }

  function requireNoCredentialField(inputs) {
    if (hasCredentialField(inputs, 0)) {
      throw FabrixError(
        "validation_error",
        "Request inputs must not contain credential-shaped fields (token, api_key, password, etc.)."
      );
    }
  }

  function requireObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw FabrixError("validation_error", label + " must be an object.");
    }
    return value;
  }

  function requireId(value, label) {
    if (typeof value !== "string" || !value || value.length > 200) {
      throw FabrixError("validation_error", (label || "id") + " must be a non-empty string id.");
    }
    return value;
  }

  function optionalId(value, label) {
    if (value === null || value === undefined) return null;
    return requireId(value, label);
  }

  function optionalText(value, max, label) {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string") {
      throw FabrixError("validation_error", label + " must be text.");
    }
    if (value.length > max) {
      throw FabrixError("validation_error", label + " must be under " + max + " characters.");
    }
    return value;
  }

  function requireTitle(value) {
    return optionalText(value, MAX_TITLE, "Title");
  }

  function requireBody(value) {
    return optionalText(value, MAX_BODY, "Body");
  }

  function optionalLimit(value) {
    if (value === null || value === undefined) return 20;
    var limit = Number(value);
    if (!Number.isFinite(limit) || limit < 1) {
      throw FabrixError("validation_error", "limit must be a number from 1 to " + MAX_LIMIT + ".");
    }
    return Math.min(Math.floor(limit), MAX_LIMIT);
  }

  function optionalTag(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string" || !/^#[a-z0-9][a-z0-9/_-]*$/.test(value.toLowerCase())) {
      throw FabrixError("validation_error", "tag must use a #tag name.");
    }
    return value.toLowerCase();
  }

  // Like optionalTag, but null/undefined inside an array is an error, not
  // "absent" — validateTags must reject [null] instead of letting undefined
  // through to appendMissingTags (which would crash on toLowerCase).
  function requireTag(value) {
    if (value === null || value === undefined) {
      throw FabrixError("validation_error", "tag must use a #tag name.");
    }
    return optionalTag(value);
  }

  function snippet(body, query) {
    var text = String(body || "").replace(/\s+/g, " ").trim();
    if (!query) return text.slice(0, 200);
    var at = text.toLowerCase().indexOf(String(query).toLowerCase());
    if (at === -1) return text.slice(0, 200);
    var start = Math.max(0, at - 60);
    var out = text.slice(start, start + 200);
    return (start > 0 ? "…" : "") + out + (start + 200 < text.length ? "…" : "");
  }

  // Extracts [[target]] / [[target|alias]] links, resolved by the domain
  // object's note lookup (passed in so this stays pure).
  function extractLinks(body, resolveNote) {
    var links = [];
    var seen = {};
    var pattern = /\[\[([^\]]+)\]\]/g;
    var match;
    while ((match = pattern.exec(String(body || ""))) !== null) {
      var raw = match[1].split("|", 2)[0].trim();
      if (!raw || seen[raw]) continue;
      seen[raw] = true;
      var note = typeof resolveNote === "function" ? resolveNote(raw) : null;
      links.push({ target: raw, noteId: note ? note.id : null, title: note ? note.title : null });
    }
    return links;
  }

  // Stamps provenance on notes created/updated through the adapter. The
  // `metadata` object survives load verbatim (see app.js loadWorkspace).
  function provenance(source) {
    return {
      fabrix: {
        source: source || "fabrix",
        syncedAt: new Date().toISOString()
      }
    };
  }

  function publicNote(note, domain) {
    return {
      id: note.id,
      title: note.title,
      body: note.body,
      folderId: note.folderId,
      parentNoteId: note.parentNoteId,
      pinned: note.pinned === true,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      tags: domain.extractTags(note.title + "\n" + note.body),
      links: extractLinks(note.body, function (target) {
        return domain.findNoteByTitleOrId(target);
      }),
      attachments: [],
      provenance: note.metadata && note.metadata.fabrix ? note.metadata.fabrix : null
    };
  }

  window.xPinFabrixDomain = Object.freeze({
    FabrixError: FabrixError,
    SECRET_KEYS: SECRET_KEYS,
    limits: Object.freeze({ maxTitle: MAX_TITLE, maxBody: MAX_BODY, maxQuery: MAX_QUERY, maxLimit: MAX_LIMIT }),
    hasCredentialField: hasCredentialField,
    requireNoCredentialField: requireNoCredentialField,
    requireObject: requireObject,
    requireId: requireId,
    optionalId: optionalId,
    optionalText: optionalText,
    requireTitle: requireTitle,
    requireBody: requireBody,
    optionalLimit: optionalLimit,
    optionalTag: optionalTag,
    requireTag: requireTag,
    snippet: snippet,
    extractLinks: extractLinks,
    provenance: provenance,
    publicNote: publicNote
  });
})();
