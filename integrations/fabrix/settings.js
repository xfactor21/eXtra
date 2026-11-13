/* xPin fabriX adapter — integration settings panel.
 *
 * Renders one section inside the feature-suite settings view
 * (feature-suite.js renderSettings). Uses plain DOM APIs and the app's
 * existing CSS classes (tools-section, feature-button, feature-input) so it
 * matches the rest of Settings with no new theme tokens.
 *
 * Every control goes through window.xPinFabrix; this file never mutates
 * xPin state directly. All labels are honest: the mock transport and the
 * Cloud Bridge stub are labeled as such; nothing claims a live connection
 * that does not exist.
 */
(function () {
  "use strict";

  // The document the panel renders into. renderSettingsSection sets this
  // from its `doc` argument so test harnesses can pass a fake document;
  // the live app passes the real one.
  var activeDoc = typeof document !== "undefined" ? document : null;

  function el(tag, className, text) {
    var node = activeDoc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function refreshSection(section) {
    var doc = section.ownerDocument || activeDoc;
    var next = renderSettingsSection(doc);
    section.replaceWith(next);
  }

  function renderSettingsSection(doc) {
    activeDoc = doc || activeDoc;
    var section = el("section", "tools-section");
    section.id = "fabrix-settings";
    section.append(el("h2", "", "fabriX integration"));
    var adapter = window.xPinFabrix;
    if (!adapter) {
      section.append(el("p", "", "The fabriX adapter failed to load. The app works normally without it."));
      return section;
    }

    var status = adapter.getStatus();
    var state = adapter.getState();

    var summary = el("p", "", "");
    if (!status.enabled) {
      summary.textContent = "Off. xPin works fully standalone — no account, no Bridge, no network. Enable it below to connect xPin to the planet.X fabriX integration layer.";
    } else if (!status.connected) {
      summary.textContent = "Enabled but not connected. No capability is available until you connect a transport and grant a permission below.";
    } else {
      summary.textContent = "Connected via " + status.transport + ". Read " + (status.grants.read ? "granted" : "not granted") +
        " · Write " + (status.grants.write ? "granted" : "not granted") +
        " · " + status.receipts + " receipts recorded.";
    }
    section.append(summary);

    var toggle = el("button", "feature-button feature-button-primary", status.enabled ? "Disable fabriX" : "Enable fabriX");
    toggle.type = "button";
    toggle.addEventListener("click", function () {
      adapter.setEnabled(!status.enabled);
      refreshSection(section);
    });
    section.append(toggle);

    if (!status.enabled) {
      section.append(el("p", "feature-help", "Disabled means disabled: no connections, no timers, no polling, no data leaves the app."));
      return section;
    }

    // Transport
    var transportLabel = el("label", "", "Transport");
    var transportSelect = el("select", "feature-select");
    [["local", "Local Bridge (Windows loopback)"], ["mock", "Mock Bridge (offline test)"], ["cloud", "Cloud Bridge (not live)"]].forEach(function (pair) {
      var option = el("option", "", pair[1]);
      option.value = pair[0];
      transportSelect.append(option);
    });
    transportSelect.value = state.transport;
    transportSelect.setAttribute("aria-label", "fabriX transport");
    transportSelect.addEventListener("change", function () {
      adapter.setTransport(transportSelect.value, {});
      refreshSection(section);
    });
    transportLabel.append(transportSelect);
    section.append(transportLabel);

    if (state.transport === "local") {
      var portLabel = el("label", "", "Local Bridge port");
      var portInput = el("input", "feature-input");
      portInput.type = "text";
      portInput.inputMode = "numeric";
      portInput.value = state.local.port || "";
      portInput.placeholder = "e.g. 51234 (from Documents\\fabriX\\Registry\\hub-port.txt)";
      portInput.setAttribute("aria-label", "Local Bridge port");
      portInput.addEventListener("change", function () {
        adapter.setTransport("local", { port: portInput.value.trim() });
        refreshSection(section);
      });
      portLabel.append(portInput);
      section.append(portLabel);

      var tokenLabel = el("label", "", "Local Bridge token");
      var tokenInput = el("input", "feature-input");
      tokenInput.type = "password";
      tokenInput.value = state.local.token || "";
      tokenInput.placeholder = "Paste from Documents\\fabriX\\Registry\\local-api-token.txt";
      tokenInput.setAttribute("aria-label", "Local Bridge token");
      tokenInput.addEventListener("change", function () {
        adapter.setTransport("local", { token: tokenInput.value.trim() });
        refreshSection(section);
      });
      tokenLabel.append(tokenInput);
      section.append(tokenLabel);
      section.append(el("p", "feature-help", "The token is a same-device loopback credential. It is stored in this workspace and sent only to 127.0.0.1. It is never placed in a capability request."));
    }

    if (state.transport === "cloud") {
      section.append(el("p", "feature-help", "Cloud Bridge is not live: the reference relay is not production-deployed (Gates A–C unmet). Connecting will report transport unavailable. This option exists so the transport can be wired later without changing the app."));
    }

    if (state.transport === "mock") {
      section.append(el("p", "feature-help", "Mock Bridge: an in-memory Bridge for offline tests and demos. Nothing leaves the app; every response is labeled mock."));
    }

    // Connect / disconnect
    var connectRow = el("div", "backup-actions");
    var connectButton = el("button", "feature-button", status.connected ? "Disconnect" : "Connect");
    connectButton.type = "button";
    connectButton.addEventListener("click", function () {
      var action = status.connected ? adapter.disconnect() : adapter.connect();
      Promise.resolve(action).then(function () {
        refreshSection(section);
      }).catch(function (error) {
        window.alert("fabriX: " + (error && error.message ? error.message : error));
        refreshSection(section);
      });
    });
    connectRow.append(connectButton);

    if (status.connected) {
      var pollButton = el("button", "feature-button", status.polling ? "Stop listening" : "Start listening for Bridge requests");
      pollButton.type = "button";
      pollButton.addEventListener("click", function () {
        try {
          if (status.polling) adapter.stopPolling();
          else adapter.startPolling();
        } catch (error) {
          window.alert("fabriX: " + (error && error.message ? error.message : error));
        }
        refreshSection(section);
      });
      connectRow.append(pollButton);

      var checkButton = el("button", "feature-button", "Check once for requests");
      checkButton.type = "button";
      checkButton.addEventListener("click", function () {
        adapter.pollOnce().then(function (summary) {
          window.alert("fabriX: handled " + summary.handled + " Bridge request(s).");
          refreshSection(section);
        }).catch(function (error) {
          window.alert("fabriX: " + (error && error.message ? error.message : error));
        });
      });
      connectRow.append(checkButton);
    }
    section.append(connectRow);

    if (status.connected && status.bridge) {
      var bridge = status.bridge;
      var routes = bridge.capability_routes;
      var routesText = routes == null ? "?" :
        (typeof routes === "object" ? Object.keys(routes).filter(function (k) { return routes[k]; }).join(", ") || "none" : String(routes));
      section.append(el("p", "feature-help",
        "Bridge: build " + (bridge.build_id || "?") +
        (bridge.mock ? " (mock)" : "") +
        " · products " + (bridge.products == null ? "?" : bridge.products) +
        " · capability routes " + routesText +
        " · cloud " + (bridge.cloud_enabled ? "enabled" : "not enabled") + "."));
    }

    // Permissions
    var grantsTitle = el("h3", "", "Permissions (deny by default)");
    section.append(grantsTitle);
    var folders = [];
    try { folders = adapter.getFolders() || []; } catch (error) { folders = []; }
    [["read", "Read — notes.search, notes.read, notes.export, projects.list"], ["write", "Write — notes.create, notes.update, artifacts.publish"]].forEach(function (pair) {
      var group = pair[0];
      var label = el("label", "", pair[1]);
      var box = activeDoc.createElement("input");
      box.type = "checkbox";
      box.checked = !!status.grants[group];
      box.setAttribute("aria-label", "Grant fabriX " + group + " permission");
      box.addEventListener("change", function () {
        if (box.checked) adapter.grant(group);
        else adapter.revoke(group);
        refreshSection(section);
      });
      label.insertBefore(box, label.firstChild || null);
      section.append(label);

      var record = state.grants && state.grants[group];
      if (record && record.granted) {
        var meta = "Granted" + (record.grantedAt ? " " + record.grantedAt : "") +
          (record.grantedBy ? " by " + record.grantedBy : "") +
          (record.reason ? " — " + record.reason : "");
        section.append(el("p", "feature-help", meta));
      }

      // Folder scope: check folders to limit this group to them; no boxes
      // checked means workspace-wide (labeled as such). Scoping works
      // before the grant is approved, so it can be set first.
      if (folders.length > 0) {
        var scopeLabel = el("p", "feature-help", group === "read" ? "Read scope (no folders checked = whole workspace):" : "Write scope (no folders checked = whole workspace):");
        section.append(scopeLabel);
        var scopeList = el("div", "");
        folders.forEach(function (folder) {
          var folderLabel = el("label", "", " " + folder.name);
          var folderBox = activeDoc.createElement("input");
          folderBox.type = "checkbox";
          folderBox.checked = (status.scopes[group] || []).indexOf(folder.id) !== -1;
          folderBox.setAttribute("aria-label", "Scope fabriX " + group + " to folder " + folder.name);
          folderBox.addEventListener("change", function () {
            var current = (adapter.getStatus().scopes[group] || []).slice();
            var at = current.indexOf(folder.id);
            if (folderBox.checked && at === -1) current.push(folder.id);
            if (!folderBox.checked && at !== -1) current.splice(at, 1);
            adapter.setScope(group, current);
            refreshSection(section);
          });
          folderLabel.insertBefore(folderBox, folderLabel.firstChild || null);
          scopeList.append(folderLabel);
        });
        section.append(scopeList);
      }

      // Write approval carries a reason (spec §6, approve/reject pattern).
      if (group === "write") {
        var reasonLabel = el("label", "", "Write approval reason");
        var reasonInput = el("input", "feature-input");
        reasonInput.type = "text";
        reasonInput.value = (record && record.reason) || "";
        reasonInput.placeholder = "e.g. Allow the Hub to file meeting notes";
        reasonInput.setAttribute("aria-label", "Write approval reason");
        reasonInput.addEventListener("change", function () {
          adapter.setReason("write", reasonInput.value.trim());
          refreshSection(section);
        });
        reasonLabel.append(reasonInput);
        section.append(reasonLabel);
      }
    });
    section.append(el("p", "feature-help", "Read never grants write. Grants are revocable here at any time; revocation takes effect immediately. Search returns snippets only — full note bodies need notes.read per note."));

    // Receipts
    var receiptsTitle = el("h3", "", "Receipts (" + state.receipts.length + ")");
    section.append(receiptsTitle);
    if (!state.receipts.length) {
      section.append(el("p", "feature-help", "No capability calls yet. Every call — allowed or denied — is recorded here."));
    } else {
      var list = el("ul", "feature-list");
      state.receipts.slice(-10).reverse().forEach(function (receipt) {
        list.append(el("li", "", receipt.completedAt + " · " + receipt.capability + " · " + receipt.status + (receipt.error ? " · " + receipt.error : "")));
      });
      section.append(list);
      var exportButton = el("button", "feature-button", "Download receipts (JSON)");
      exportButton.type = "button";
      exportButton.addEventListener("click", function () {
        var blob = new Blob([adapter.exportReceipts()], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "xpin-fabrix-receipts.json";
        anchor.click();
        URL.revokeObjectURL(url);
      });
      section.append(exportButton);
    }

    return section;
  }

  window.xPinFabrixSettings = Object.freeze({
    renderSettingsSection: renderSettingsSection
  });
})();
