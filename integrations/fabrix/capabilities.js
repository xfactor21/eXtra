/* xPin fabriX adapter — capability handlers.
 *
 * The seven initial capabilities (spec §5). Each handler is a pure function
 * over the injected `FabrixDomain` object (built by app.js, see
 * createFabrixDomain): it validates inputs, enforces the permission model,
 * calls the domain, and returns a structured result. It never touches xPin's
 * `state` directly and never performs network I/O.
 *
 * Tags: xPin has no separate tag field — tags live in note text as #tag.
 * When a caller supplies tags[], missing tags are appended to the body as a
 * trailing line (the app's own convention). Bodies are never rewritten
 * beyond that append.
 */
(function () {
  "use strict";

  var D = window.xPinFabrixDomain;
  var P = window.xPinFabrixPermissions;

  function appendMissingTags(body, tags) {
    if (!tags || tags.length === 0) return body;
    var existing = {};
    var found = String(body || "").match(/(?:^|\s)(#[a-z0-9][a-z0-9/_-]*)/gi) || [];
    found.forEach(function (tag) { existing[tag.toLowerCase()] = true; });
    var missing = tags.filter(function (tag) { return !existing[tag.toLowerCase()]; });
    if (missing.length === 0) return body;
    var separator = body && !body.endsWith("\n") ? "\n\n" : (body ? "\n" : "");
    return body + separator + missing.join(" ");
  }

  function validateTags(tags) {
    if (tags === null || tags === undefined) return [];
    if (!Array.isArray(tags)) throw D.FabrixError("validation_error", "tags must be an array of #tag names.");
    if (tags.length > 50) throw D.FabrixError("validation_error", "At most 50 tags per call.");
    return tags.map(function (tag) { return D.optionalTag(tag); });
  }

  var handlers = {
    "notes.search": function (domain, fabrixState, inputs) {
      P.requireGrant(fabrixState, "notes.search");
      var query = D.optionalText(inputs.query, D.limits.maxQuery, "query");
      var tag = D.optionalTag(inputs.tag);
      var folderId = D.optionalId(inputs.folderId, "folderId");
      var limit = D.optionalLimit(inputs.limit);
      if (folderId !== null) P.requireScope(fabrixState, folderId);
      var matches = domain.searchNotes({ query: query, tag: tag, folderId: folderId, limit: limit });
      return {
        notes: matches.map(function (note) {
          return {
            id: note.id,
            title: note.title,
            snippet: D.snippet(note.body, query),
            folderId: note.folderId,
            tags: domain.extractTags(note.title + "\n" + note.body),
            updatedAt: note.updatedAt
          };
        })
      };
    },

    "notes.read": function (domain, fabrixState, inputs) {
      P.requireGrant(fabrixState, "notes.read");
      var id = D.requireId(inputs.id, "id");
      var note = domain.readNote(id);
      if (!note) throw D.FabrixError("not_found", "No note with id " + id + ".");
      P.requireScope(fabrixState, note.folderId);
      return { note: D.publicNote(note, domain) };
    },

    "notes.create": function (domain, fabrixState, inputs) {
      P.requireGrant(fabrixState, "notes.create");
      var title = D.requireTitle(inputs.title);
      var body = D.requireBody(inputs.body);
      var folderId = D.optionalId(inputs.folderId, "folderId");
      var parentNoteId = D.optionalId(inputs.parentNoteId, "parentNoteId");
      var tags = validateTags(inputs.tags);
      if (folderId !== null) P.requireScope(fabrixState, folderId);
      var finalBody = appendMissingTags(body || "", tags);
      var note = domain.createNote({
        title: title || "",
        body: finalBody,
        folderId: folderId,
        parentNoteId: parentNoteId,
        metadata: D.provenance("fabrix")
      });
      return { note: D.publicNote(note, domain) };
    },

    "notes.update": function (domain, fabrixState, inputs) {
      P.requireGrant(fabrixState, "notes.update");
      var id = D.requireId(inputs.id, "id");
      var existing = domain.readNote(id);
      if (!existing) throw D.FabrixError("not_found", "No note with id " + id + ".");
      if (inputs.expectedUpdatedAt !== undefined && inputs.expectedUpdatedAt !== null) {
        if (typeof inputs.expectedUpdatedAt !== "string") {
          throw D.FabrixError("validation_error", "expectedUpdatedAt must be an ISO timestamp string.");
        }
        if (inputs.expectedUpdatedAt !== existing.updatedAt) {
          var conflict = D.FabrixError("conflict", "The note changed since " + inputs.expectedUpdatedAt + "; no write was performed.");
          conflict.currentUpdatedAt = existing.updatedAt;
          throw conflict;
        }
      }
      var patch = {};
      if (inputs.title !== undefined) patch.title = D.requireTitle(inputs.title);
      if (inputs.body !== undefined) patch.body = D.requireBody(inputs.body);
      if (inputs.folderId !== undefined) patch.folderId = D.optionalId(inputs.folderId, "folderId");
      var tags = validateTags(inputs.tags);
      if (patch.folderId !== undefined && patch.folderId !== null) P.requireScope(fabrixState, patch.folderId);
      P.requireScope(fabrixState, existing.folderId);
      if (tags.length > 0) {
        var baseBody = patch.body !== undefined ? patch.body : existing.body;
        patch.body = appendMissingTags(baseBody, tags);
      }
      if (Object.keys(patch).length === 0) {
        throw D.FabrixError("validation_error", "notes.update changed nothing: supply title, body, folderId, or tags.");
      }
      patch.metadata = Object.assign({}, existing.metadata || {}, D.provenance("fabrix"));
      var note = domain.updateNote(id, patch);
      return { note: D.publicNote(note, domain) };
    },

    "notes.export": function (domain, fabrixState, inputs) {
      P.requireGrant(fabrixState, "notes.export");
      var format = inputs.format === undefined || inputs.format === null ? "markdown" : inputs.format;
      if (format !== "markdown" && format !== "html") {
        throw D.FabrixError("validation_error", "format must be 'markdown' or 'html'.");
      }
      var ids = [];
      if (inputs.id !== undefined && inputs.id !== null) ids.push(D.requireId(inputs.id, "id"));
      if (Array.isArray(inputs.ids)) {
        if (inputs.ids.length > 100) throw D.FabrixError("validation_error", "At most 100 notes per export call.");
        inputs.ids.forEach(function (id) { ids.push(D.requireId(id, "id")); });
      }
      if (ids.length === 0) throw D.FabrixError("validation_error", "notes.export requires id or ids.");
      var files = [];
      ids.forEach(function (id) {
        var note = domain.readNote(id);
        if (!note) throw D.FabrixError("not_found", "No note with id " + id + ".");
        P.requireScope(fabrixState, note.folderId);
        files.push(domain.exportNote(id, format));
      });
      return { format: format, files: files };
    },

    "projects.list": function (domain, fabrixState) {
      P.requireGrant(fabrixState, "projects.list");
      // Metadata only. Row values are never returned by this capability.
      return { projects: domain.listProjects() };
    },

    "artifacts.publish": function (domain, fabrixState, inputs) {
      P.requireGrant(fabrixState, "artifacts.publish");
      var id = D.requireId(inputs.id, "id");
      var title = D.optionalText(inputs.title, D.limits.maxTitle, "title");
      var note = domain.readNote(id);
      if (!note) throw D.FabrixError("not_found", "No note with id " + id + ".");
      P.requireScope(fabrixState, note.folderId);
      // No publish target is configured today (spec §9, P2): the artifact is
      // recorded locally and returned. The adapter never claims an upload.
      var artifact = domain.publishArtifact(id, title === undefined ? null : title);
      return { artifact: artifact };
    }
  };

  function execute(domain, fabrixState, capability, inputs, context) {
    if (!domain) throw D.FabrixError("internal_error", "The fabriX domain is not attached.");
    D.requireNoCredentialField(inputs);
    if (!P.isKnown(capability)) {
      throw D.FabrixError("capability_unknown", "Unknown capability: " + String(capability));
    }
    var safeInputs = inputs && typeof inputs === "object" && !Array.isArray(inputs) ? inputs : {};
    var result = handlers[capability](domain, fabrixState, safeInputs, context || {});
    return result;
  }

  window.xPinFabrixCapabilities = Object.freeze({
    handlers: handlers,
    execute: execute,
    capabilityNames: Object.freeze(Object.keys(handlers))
  });
})();
