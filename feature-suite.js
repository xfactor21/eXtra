(() => {
  "use strict";

  const VIEW_NAMES = ["database", "graph", "settings"];
  const DATABASE_VIEWS = ["table", "board", "calendar", "gallery", "timeline"];
  const COLUMN_TYPES = ["text", "status", "date", "number", "relation", "rollup", "formula"];
  const ACCENTS = {
    cyan: ["#54dce8", "#83f0f3"],
    coral: ["#ff755d", "#ff9b86"],
    violet: ["#b49aff", "#d0bdff"],
    mint: ["#71d4a9", "#a0edc9"]
  };
  const STATUSES = ["Not started", "In progress", "Done"];
  const makeColumn = (id, name, type, extra = {}) => ({ id, name, type, ...extra });

  function initialState() {
    return {
      activeView: null,
      theme: { accent: "cyan", density: "comfortable" },
      syncedBlocks: [],
      selectedTableId: "db-projects",
      tables: [
        {
          id: "db-projects",
          name: "Projects",
          view: "table",
          columns: [
            makeColumn("project-name", "Name", "text"),
            makeColumn("project-status", "Status", "status"),
            makeColumn("project-tasks", "Linked tasks", "rollup")
          ],
          rows: []
        },
        {
          id: "db-tasks",
          name: "Tasks",
          view: "table",
          columns: [
            makeColumn("task-name", "Name", "text"),
            makeColumn("task-status", "Status", "status"),
            makeColumn("task-due", "Due", "date"),
            makeColumn("task-project", "Project", "relation", { targetTableId: "db-projects" }),
            makeColumn("task-note", "Related page", "relation", { targetTableId: "notes" })
          ],
          rows: []
        }
      ],
      query: "LIST FROM notes"
    };
  }

  function sanitizeState(value, notes = []) {
    const defaults = initialState();
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
    const rawTables = Array.isArray(value.tables) ? value.tables.slice(0, 20) : defaults.tables;
    const tableIds = new Set();
    const tables = rawTables.flatMap((source) => {
      if (!source || typeof source.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) ||
        tableIds.has(source.id) || typeof source.name !== "string") return [];
      tableIds.add(source.id);
      return [{
        id: source.id,
        name: source.name.trim().slice(0, 80) || "Untitled database",
        view: DATABASE_VIEWS.includes(source.view) ? source.view : "table",
        columns: [],
        rows: []
      }];
    });
    const tableById = new Map(tables.map((table) => [table.id, table]));
    rawTables.forEach((source) => {
      const table = tableById.get(source?.id);
      if (!table) return;
      const columns = Array.isArray(source.columns) ? source.columns.slice(0, 30) : [];
      const columnIds = new Set();
      table.columns = columns.flatMap((column) => {
        if (!column || typeof column.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(column.id) ||
          columnIds.has(column.id) || !COLUMN_TYPES.includes(column.type) || typeof column.name !== "string") return [];
        if (column.type === "relation" && column.targetTableId !== "notes" && !tableById.has(column.targetTableId)) return [];
        columnIds.add(column.id);
        const safe = makeColumn(column.id, column.name.trim().slice(0, 80) || "Untitled", column.type);
        if (column.type === "relation") safe.targetTableId = column.targetTableId;
        if (column.type === "rollup") {
          safe.aggregation = "count";
          if (typeof column.sourceColumnId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(column.sourceColumnId)) {
            // Deep validity (still a live relation targeting this table) is checked at count time;
            // a stale scope cleanly falls back to counting all inbound relations.
            safe.sourceColumnId = column.sourceColumnId;
          }
        }
        // Phase 3 (Databases v2) — formula columns keep their expression
        // (a safe, hand-parsed expression; never eval). Invalid expressions
        // are kept too and render as an error, never silently dropped.
        if (column.type === "formula" && typeof column.expression === "string") {
          safe.expression = column.expression.slice(0, 500);
        }
        return [safe];
      });
      if (!table.columns.length) table.columns.push(makeColumn(makeId("field"), "Name", "text"));
      const rowIds = new Set();
      table.rows = (Array.isArray(source.rows) ? source.rows : []).slice(0, 5000).flatMap((row) => {
        if (!row || typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.id) || rowIds.has(row.id)) return [];
        rowIds.add(row.id);
        const values = {};
        for (const column of table.columns) {
          const item = row.values?.[column.id];
          if (column.type === "text" && typeof item === "string") values[column.id] = item.slice(0, 2000);
          if (column.type === "status" && typeof item === "string" && STATUSES.includes(item)) values[column.id] = item;
          if (column.type === "date" && typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item)) values[column.id] = item;
          if (column.type === "number" && Number.isFinite(item)) values[column.id] = Math.max(-1_000_000, Math.min(1_000_000, item));
          if (column.type === "relation" && typeof item === "string") values[column.id] = item.slice(0, 100);
        }
        return [{ id: row.id, values }];
      });
    });
    for (const table of tables) {
      table.rows.forEach((row) => {
        table.columns.filter((column) => column.type === "relation").forEach((column) => {
          const value = row.values[column.id];
          if (!value) return;
          const targetExists = column.targetTableId === "notes"
            ? notes.some((note) => note?.id === value)
            : tableById.get(column.targetTableId)?.rows.some((item) => item.id === value);
          if (!targetExists) delete row.values[column.id];
        });
      });
    }
    const activeView = VIEW_NAMES.includes(value.activeView) ? value.activeView : null;
    const accent = Object.hasOwn(ACCENTS, value.theme?.accent) ? value.theme.accent : "cyan";
    const density = value.theme?.density === "compact" ? "compact" : "comfortable";
    const syncedBlocks = (Array.isArray(value.syncedBlocks) ? value.syncedBlocks : []).slice(0, 200).flatMap((block) =>
      block && typeof block.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(block.id) &&
      typeof block.title === "string" && typeof block.content === "string"
        ? [{ id: block.id, title: block.title.slice(0, 100), content: block.content.slice(0, 20_000) }]
        : []
    );
    return {
      activeView,
      theme: { accent, density },
      syncedBlocks,
      selectedTableId: tables.some((table) => table.id === value.selectedTableId)
        ? value.selectedTableId
        : tables[0]?.id ?? null,
      tables: tables.length ? tables : defaults.tables,
      query: typeof value.query === "string" ? value.query.slice(0, 500) : defaults.query
    };
  }

  function makeId(prefix) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
  }

  function formatDate(value) {
    return new Date(value).toLocaleDateString();
  }

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function create(host) {
    const section = document.getElementById("feature-view");
    const content = document.getElementById("feature-content");
    const heading = document.getElementById("page-title");
    const subtitle = document.querySelector("#notes-heading .page-subtitle");
    const navLabel = document.getElementById("current-view-label");
    const featureState = host.getState().features;
    let active = featureState.activeView;
    let queryResult = null;
    let queryHelpOpen = false;
    let slashMenu = null;

    function save() {
      host.persist();
    }

    function setTitle(title, description) {
      heading.innerHTML = `${title}<span class="title-period">.</span>`;
      subtitle.textContent = description;
      navLabel.textContent = title;
    }

    function open(view) {
      if (!VIEW_NAMES.includes(view)) return;
      active = view;
      featureState.activeView = view;
      host.getState().view = "notes";
      document.getElementById("notes-toolbar").hidden = true;
      document.getElementById("notes-layout").hidden = true;
      document.getElementById("canvas-view").hidden = true;
      document.getElementById("new-folder").hidden = true;
      section.hidden = false;
      document.querySelectorAll(".nav-item").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.featureView === view);
      });
      document.querySelectorAll(".feature-tab").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.featureView === view);
      });
      const labels = {
        database: ["Databases", "One set of records, five ways to see it."],
        graph: ["Note graph", "Follow the links and parent pages that already live in your notes."],
        settings: ["Workspace tools", "Make a safe portable copy, tune the canvas, or export a page."]
      };
      setTitle(...labels[view]);
      render();
      save();
    }

    function deactivate() {
      if (!active) return;
      active = null;
      featureState.activeView = null;
      section.hidden = true;
      document.getElementById("notes-toolbar").hidden = host.getState().view === "canvas";
      document.getElementById("notes-layout").hidden = host.getState().view === "canvas";
      document.getElementById("canvas-view").hidden = host.getState().view !== "canvas";
      document.getElementById("new-folder").hidden = host.getState().view === "canvas";
      document.querySelectorAll(".nav-item").forEach((button) => {
        button.classList.toggle("is-active", host.getState().view === "canvas"
          ? button.dataset.view === "canvas"
          : button.dataset.filter === host.getState().filter);
      });
    }

    function tableById(id) {
      return featureState.tables.find((table) => table.id === id) ?? null;
    }

    // Phase 1 (audit C2): event bus extension. The host emits note events
    // from app.js; the feature suite emits database/canvas/template/tag/
    // settings/save/sync events from its own mutation sites.
    function emit(name, detail) {
      try {
        host.emit?.(name, detail);
      } catch (error) {
        console.error("xPin feature event failed.", error);
      }
    }

    function columnById(table, id) {
      return table.columns.find((column) => column.id === id) ?? null;
    }

    function renderDatabase() {
      const wrap = el("div", "database-workspace");
      const header = el("div", "feature-page-header");
      const titleGroup = el("div");
      titleGroup.append(el("h2", "", "Flexible databases"), el("p", "", "Relations connect records; rollups summarize the links."));
      const controls = el("div", "database-controls");
      const tablePicker = el("select", "feature-select");
      tablePicker.setAttribute("aria-label", "Choose database");
      featureState.tables.forEach((table) => {
        const option = el("option", "", table.name);
        option.value = table.id;
        tablePicker.append(option);
      });
      const selectedTableId = tableById(featureState.selectedTableId)?.id ?? featureState.tables[0]?.id;
      const table = tableById(selectedTableId);
      tablePicker.value = table?.id ?? "";
      tablePicker.dataset.action = "select-table";
      const viewPicker = el("select", "feature-select");
      viewPicker.setAttribute("aria-label", "Choose database view");
      DATABASE_VIEWS.forEach((view) => {
        const option = el("option", "", view[0].toLocaleUpperCase() + view.slice(1));
        option.value = view;
        viewPicker.append(option);
      });
      viewPicker.value = table?.view ?? "table";
      viewPicker.dataset.action = "select-view";
      const addRow = el("button", "feature-button feature-button-primary", "＋ New row");
      addRow.type = "button";
      addRow.dataset.action = "add-row";
      const addTable = el("button", "feature-button", "＋ Database");
      addTable.type = "button";
      addTable.dataset.action = "add-table";
      const renameTableButton = el("button", "feature-button", "Rename");
      renameTableButton.type = "button";
      renameTableButton.dataset.action = "rename-table";
      const deleteTableButton = el("button", "feature-button", "Delete");
      deleteTableButton.type = "button";
      deleteTableButton.dataset.action = "delete-table";
      controls.append(tablePicker, viewPicker, addRow, addTable, renameTableButton, deleteTableButton);
      header.append(titleGroup, controls);
      wrap.append(header);
      if (!table) {
        wrap.append(el("p", "feature-empty", "Create a database to get started."));
        content.replaceChildren(wrap);
        return;
      }
      table.rows = table.rows.slice(0, 5000);
      if (table.view === "table") wrap.append(renderTable(table));
      else if (table.view === "board") wrap.append(renderBoard(table));
      else if (table.view === "calendar") wrap.append(renderCalendar(table));
      else if (table.view === "gallery") wrap.append(renderGallery(table));
      else wrap.append(renderTimeline(table));
      wrap.append(renderQuery());
      content.replaceChildren(wrap);
    }

    function fieldControl(table, row, column) {
      const value = row.values[column.id] ?? "";
      // Phase 3 (Databases v2) — formula columns compute live and are
      // read-only. The expression is parsed by hand, never eval'd.
      if (column.type === "formula") {
        const result = window.xPinPhase3?.evaluateFormula(column.expression ?? "", row, table.columns);
        const badge = el("span", "formula-value", result?.ok
          ? window.xPinPhase3.formatFormulaValue(result.value)
          : `⚠ ${result?.error ?? "Invalid formula"}`);
        badge.title = column.expression ? `Formula: ${column.expression}` : "No formula set for this column.";
        return badge;
      }
      if (column.type === "rollup") {
        const badge = el("span", "rollup-value", String(incomingRelations(table.id, row.id, column.sourceColumnId)));
        badge.title = column.sourceColumnId
          ? "Count of records linked to this row through the selected relation."
          : "Count of records in other tables related to this row.";
        return badge;
      }
      if (column.type === "status") {
        const select = el("select", "database-cell-select");
        select.dataset.rowId = row.id;
        select.dataset.columnId = column.id;
        select.dataset.action = "cell-change";
        select.setAttribute("aria-label", `${column.name} for ${row.values[table.columns[0].id] || "row"}`);
        const empty = el("option", "", "Choose status");
        empty.value = "";
        select.append(empty);
        STATUSES.forEach((status) => {
          const option = el("option", "", status);
          option.value = status;
          select.append(option);
        });
        select.value = value;
        return select;
      }
      if (column.type === "relation") {
        const select = el("select", "database-cell-select");
        select.dataset.rowId = row.id;
        select.dataset.columnId = column.id;
        select.dataset.action = "cell-change";
        select.setAttribute("aria-label", `${column.name} relation`);
        const empty = el("option", "", "No relation");
        empty.value = "";
        select.append(empty);
        const options = column.targetTableId === "notes"
          ? host.getState().notes.map((item) => ({ id: item.id, name: item.title || "Untitled page" }))
          : (tableById(column.targetTableId)?.rows ?? []).map((item) => ({
            id: item.id,
            name: item.values[tableById(column.targetTableId).columns[0]?.id] || "Untitled record"
          }));
        options.forEach((item) => {
          const option = el("option", "", item.name);
          option.value = item.id;
          select.append(option);
        });
        select.value = value;
        return select;
      }
      const input = el("input", "database-cell-input");
      input.dataset.rowId = row.id;
      input.dataset.columnId = column.id;
      input.dataset.action = "cell-input";
      input.setAttribute("aria-label", `${column.name} for row`);
      if (column.type === "date") input.type = "date";
      else if (column.type === "number") {
        input.type = "number";
        input.step = "any";
      } else {
        input.type = "text";
        input.maxLength = 2000;
        input.placeholder = column.name === "Name" ? "New record" : "";
      }
      input.value = value;
      return input;
    }

    // Phase 3 (Databases v2) — per-view sort, filter, and group. The view
    // state lives in phase3.dbViews[tableId]; the table view is the one
    // that applies it (board/calendar/gallery/timeline keep their own
    // shapes and show the unfiltered rows).
    function dbViewState(tableId) {
      const phase3 = host.getState().phase3;
      if (!phase3) return { sortColumnId: "", sortDir: "asc", filterColumnId: "", filterOp: "", filterValue: "", groupByColumnId: "" };
      if (!phase3.dbViews) phase3.dbViews = {};
      if (!phase3.dbViews[tableId]) {
        phase3.dbViews[tableId] = { sortColumnId: "", sortDir: "asc", filterColumnId: "", filterOp: "", filterValue: "", groupByColumnId: "" };
      }
      return phase3.dbViews[tableId];
    }

    function renderViewControls(table) {
      const view = dbViewState(table.id);
      const bar = el("div", "database-view-controls");
      bar.append(el("span", "database-view-label", "View:"));
      const sort = el("select", "feature-select");
      sort.dataset.action = "view-sort";
      sort.setAttribute("aria-label", "Sort by column");
      const noSort = el("option", "", "No sorting");
      noSort.value = "";
      sort.append(noSort);
      table.columns.forEach((column) => {
        const option = el("option", "", column.name);
        option.value = column.id;
        if (column.id === view.sortColumnId) option.selected = true;
        sort.append(option);
      });
      const dir = el("select", "feature-select");
      dir.dataset.action = "view-sort-dir";
      dir.setAttribute("aria-label", "Sort direction");
      [["asc", "↑ A–Z / low–high"], ["desc", "↓ Z–A / high–low"]].forEach(([value, label]) => {
        const option = el("option", "", label);
        option.value = value;
        if (value === view.sortDir) option.selected = true;
        dir.append(option);
      });
      const filterColumn = el("select", "feature-select");
      filterColumn.dataset.action = "view-filter-column";
      filterColumn.setAttribute("aria-label", "Filter by column");
      const noFilter = el("option", "", "No filter");
      noFilter.value = "";
      filterColumn.append(noFilter);
      table.columns.forEach((column) => {
        const option = el("option", "", column.name);
        option.value = column.id;
        if (column.id === view.filterColumnId) option.selected = true;
        filterColumn.append(option);
      });
      const filterOp = el("select", "feature-select");
      filterOp.dataset.action = "view-filter-op";
      filterOp.setAttribute("aria-label", "Filter operator");
      [["=", "is"], ["contains", "contains"], [">", ">"], ["<", "<"], ["empty", "is empty"], ["not-empty", "is not empty"]].forEach(([value, label]) => {
        const option = el("option", "", label);
        option.value = value;
        if (value === view.filterOp) option.selected = true;
        filterOp.append(option);
      });
      const filterValue = el("input", "feature-input");
      filterValue.dataset.action = "view-filter-value";
      filterValue.placeholder = "Filter value";
      filterValue.value = view.filterValue;
      filterValue.setAttribute("aria-label", "Filter value");
      const group = el("select", "feature-select");
      group.dataset.action = "view-group";
      group.setAttribute("aria-label", "Group by column");
      const noGroup = el("option", "", "No grouping");
      noGroup.value = "";
      group.append(noGroup);
      table.columns.forEach((column) => {
        const option = el("option", "", column.name);
        option.value = column.id;
        if (column.id === view.groupByColumnId) option.selected = true;
        group.append(option);
      });
      bar.append(sort, dir, filterColumn, filterOp, filterValue, group);
      bar.append(el("span", "feature-help", "Sort, filter, and group apply to the table view only."));
      return bar;
    }

    function renderTable(table) {
      const container = el("div", "database-table-scroll");
      container.append(renderViewControls(table));
      const view = dbViewState(table.id);
      const applied = window.xPinPhase3?.applyDatabaseView
        ? window.xPinPhase3.applyDatabaseView(table.rows, table.columns, view)
        : { rows: table.rows, groups: null };
      const tableElement = el("table", "database-table");
      const head = el("thead");
      const headerRow = el("tr");
      table.columns.forEach((column) => headerRow.append(el("th", "", column.name)));
      headerRow.append(el("th", "database-row-action-heading", " "));
      head.append(headerRow);
      const body = el("tbody");
      const renderRow = (row) => {
        const tr = el("tr");
        table.columns.forEach((column) => {
          const td = el("td");
          td.append(fieldControl(table, row, column));
          tr.append(td);
        });
        const actionCell = el("td");
        // Phase 3 — a row with a date field can set a reminder for that day.
        const dateColumn = table.columns.find((column) => column.type === "date" && row.values[column.id]);
        if (dateColumn) {
          const remind = el("button", "database-row-remind", "⏰");
          remind.type = "button";
          remind.dataset.action = "remind-row";
          remind.dataset.rowId = row.id;
          remind.dataset.date = row.values[dateColumn.id];
          remind.setAttribute("aria-label", `Remind me on ${row.values[dateColumn.id]}`);
          remind.title = `Remind me on ${row.values[dateColumn.id]}`;
          actionCell.append(remind);
        }
        const remove = el("button", "database-row-remove", "×");
        remove.type = "button";
        remove.dataset.action = "delete-row";
        remove.dataset.rowId = row.id;
        remove.setAttribute("aria-label", "Delete row");
        actionCell.append(remove);
        tr.append(actionCell);
        body.append(tr);
      };
      if (applied.groups) {
        for (const group of applied.groups) {
          const groupRow = el("tr");
          const groupCell = el("td", "database-group-heading", `${group.key} (${group.rows.length})`);
          groupCell.colSpan = table.columns.length + 1;
          groupRow.append(groupCell);
          body.append(groupRow);
          group.rows.forEach(renderRow);
        }
      } else {
        applied.rows.forEach(renderRow);
      }
      if (!applied.rows.length) {
        const tr = el("tr");
        const td = el("td", "database-empty-cell", table.rows.length ? "No records match this view. Clear the filter to see them all." : "No records yet. Add a row, then connect it to another table.");
        td.colSpan = table.columns.length + 1;
        tr.append(td);
        body.append(tr);
      }
      tableElement.append(head, body);
      container.append(tableElement);
      const footer = el("div", "database-footer", applied.rows.length === table.rows.length
        ? `${table.rows.length} ${table.rows.length === 1 ? "record" : "records"} · ${table.columns.length} properties`
        : `${applied.rows.length} of ${table.rows.length} records · ${table.columns.length} properties`);
      const fieldControls = el("div", "database-add-field");
      const name = el("input", "feature-input");
      name.placeholder = "Property name";
      name.maxLength = 80;
      name.dataset.role = "new-column-name";
      name.setAttribute("aria-label", "New property name");
      const type = el("select", "feature-select");
      type.dataset.role = "new-column-type";
      type.setAttribute("aria-label", "New property type");
      [
        ["text", "Text"], ["status", "Status"], ["date", "Date"], ["number", "Number"],
        ["relation", "Relation"], ["rollup", "Rollup count"], ["formula", "Formula"]
      ].forEach(([value, label]) => {
        const option = el("option", "", label);
        option.value = value;
        type.append(option);
      });
      const target = el("select", "feature-select");
      target.dataset.role = "new-column-target";
      target.setAttribute("aria-label", "Relation target database");
      const notesOption = el("option", "", "Notes");
      notesOption.value = "notes";
      target.append(notesOption);
      featureState.tables.filter((candidate) => candidate.id !== table.id).forEach((candidate) => {
        const option = el("option", "", candidate.name);
        option.value = candidate.id;
        target.append(option);
      });
      const source = el("select", "feature-select");
      source.dataset.role = "new-column-source";
      source.setAttribute("aria-label", "Rollup relation source");
      const allOption = el("option", "", "All incoming relations");
      allOption.value = "";
      source.append(allOption);
      rollupSources(table).forEach((item) => {
        const option = el("option", "", item.label);
        option.value = item.id;
        source.append(option);
      });
      target.hidden = type.value !== "relation";
      source.hidden = type.value !== "rollup";
      // Phase 3 — formula expression input, shown only for formula columns.
      const expression = el("input", "feature-input");
      expression.placeholder = "Formula, e.g. = price * qty";
      expression.maxLength = 500;
      expression.dataset.role = "new-column-expression";
      expression.setAttribute("aria-label", "Formula expression (e.g. = price * qty, = days(due, today()))");
      expression.hidden = type.value !== "formula";
      type.addEventListener("change", () => {
        target.hidden = type.value !== "relation";
        source.hidden = type.value !== "rollup";
        expression.hidden = type.value !== "formula";
      });
      const add = el("button", "feature-button", "＋ Property");
      add.type = "button";
      add.dataset.action = "add-column";
      fieldControls.append(name, type, target, source, expression, add);
      const manageControls = el("div", "database-add-field");
      const existing = el("select", "feature-select");
      existing.dataset.role = "manage-column";
      existing.setAttribute("aria-label", "Choose property to manage");
      table.columns.forEach((column) => {
        const option = el("option", "", `${column.name} (${column.type})`);
        option.value = column.id;
        existing.append(option);
      });
      const renameColumnButton = el("button", "feature-button", "Rename property");
      renameColumnButton.type = "button";
      renameColumnButton.dataset.action = "rename-column";
      const deleteColumnButton = el("button", "feature-button", "Delete property");
      deleteColumnButton.type = "button";
      deleteColumnButton.dataset.action = "delete-column";
      manageControls.append(existing, renameColumnButton, deleteColumnButton);
      const bottom = el("div", "database-table-bottom");
      bottom.append(footer, fieldControls, manageControls);
      container.append(bottom);
      return container;
    }

    function valueText(table, row, column) {
      const value = row.values[column.id] ?? "";
      if (column.type === "formula") {
        const result = window.xPinPhase3?.evaluateFormula(column.expression ?? "", row, table.columns);
        return result?.ok ? window.xPinPhase3.formatFormulaValue(result.value) : "";
      }
      if (column.type === "rollup") return `${incomingRelations(table.id, row.id, column.sourceColumnId)} linked`;
      if (column.type === "relation") {
        if (column.targetTableId === "notes") return host.getState().notes.find((note) => note.id === value)?.title ?? "";
        const relatedTable = tableById(column.targetTableId);
        const relatedRow = relatedTable?.rows.find((item) => item.id === value);
        return relatedRow?.values[relatedTable.columns[0]?.id] ?? "";
      }
      return String(value);
    }

    function renderGallery(table) {
      const gallery = el("div", "database-gallery");
      table.rows.forEach((row) => {
        const card = el("article", "database-gallery-item");
        card.append(el("span", "gallery-pin", "◆"), el("h3", "", row.values[table.columns[0]?.id] || "Untitled record"));
        table.columns.slice(1).forEach((column) => {
          const value = valueText(table, row, column);
          if (value) card.append(el("p", "", `${column.name} · ${value}`));
        });
        const noteId = rowLinkedNoteId(table, row);
        if (noteId) {
          card.classList.add("is-linked");
          card.tabIndex = 0;
          card.setAttribute("role", "button");
          card.title = "Open linked page";
          const openNote = () => {
            deactivate();
            host.selectNote(noteId);
          };
          card.addEventListener("click", openNote);
          card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openNote();
            }
          });
        }
        gallery.append(card);
      });
      if (!table.rows.length) gallery.append(el("p", "feature-empty", "Your gallery is ready for its first record."));
      return gallery;
    }

    function renderBoard(table) {
      const board = el("div", "database-board");
      const statusColumn = table.columns.find((column) => column.type === "status");
      // Lanes follow the status values actually present in the data; the defaults are only a
      // fallback when there is nothing to show yet.
      const present = [];
      table.rows.forEach((row) => {
        const value = row.values[statusColumn?.id] ?? "Not started";
        if (!present.includes(value)) present.push(value);
      });
      const lanes = present.length ? present : STATUSES.slice();
      lanes.forEach((status) => {
        const lane = el("section", "database-lane");
        const records = table.rows.filter((row) => (row.values[statusColumn?.id] ?? "Not started") === status);
        lane.append(el("h3", "", `${status} · ${records.length}`));
        records.forEach((row) => {
          const card = el("article", "database-board-card");
          card.append(el("strong", "", row.values[table.columns[0]?.id] || "Untitled record"));
          table.columns.filter((column) => column.type === "date" || column.type === "relation" || column.type === "rollup").forEach((column) => {
            const value = valueText(table, row, column);
            if (value) card.append(el("small", "", `${column.name} · ${value}`));
          });
          const selector = fieldControl(table, row, table.columns.find((column) => column.type === "status") ?? table.columns[0]);
          if (selector.tagName === "SELECT") card.append(selector);
          lane.append(card);
        });
        board.append(lane);
      });
      return board;
    }

    function renderCalendar(table) {
      const calendar = el("div", "database-calendar");
      const dateColumn = table.columns.find((column) => column.type === "date");
      const groups = new Map();
      table.rows.forEach((row) => {
        const date = row.values[dateColumn?.id] || "No date";
        groups.set(date, [...(groups.get(date) ?? []), row]);
      });
      [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([date, rows]) => {
        const day = el("section", "calendar-day");
        day.append(el("h3", "", date));
        rows.forEach((row) => {
          const entry = el("p", "", row.values[table.columns[0]?.id] || "Untitled record");
          const noteId = rowLinkedNoteId(table, row);
          if (noteId) {
            entry.classList.add("is-linked");
            entry.tabIndex = 0;
            entry.setAttribute("role", "button");
            entry.title = "Open linked page";
            entry.addEventListener("click", () => {
              deactivate();
              host.selectNote(noteId);
            });
          }
          day.append(entry);
        });
        calendar.append(day);
      });
      if (!groups.size) calendar.append(el("p", "feature-empty", "Add dates to place records on the calendar."));
      return calendar;
    }

    // Timeline stays read-only on purpose: it is a chronological overview of records, and a
    // record has no single obvious target to open, so no click interaction is attached here.
    function renderTimeline(table) {
      const timeline = el("div", "database-timeline");
      const dateColumn = table.columns.find((column) => column.type === "date");
      const rows = [...table.rows].sort((a, b) => (a.values[dateColumn?.id] ?? "").localeCompare(b.values[dateColumn?.id] ?? ""));
      rows.forEach((row, index) => {
        const item = el("article", "timeline-row");
        item.append(el("span", "timeline-date", row.values[dateColumn?.id] || "Unscheduled"));
        const marker = el("span", "timeline-marker");
        marker.setAttribute("aria-hidden", "true");
        item.append(marker, el("strong", "", row.values[table.columns[0]?.id] || "Untitled record"));
        timeline.append(item);
      });
      if (!rows.length) timeline.append(el("p", "feature-empty", "Set a due date to start a timeline."));
      return timeline;
    }

    // Resolves the page a record links to (via its first relation-to-notes column), or null
    // when the record has no live link to a note. Used to make gallery/calendar entries clickable.
    function rowLinkedNoteId(table, row) {
      const column = table.columns.find((item) => item.type === "relation" && item.targetTableId === "notes");
      const id = column ? row.values[column.id] : "";
      return id && host.getState().notes.some((note) => note.id === id) ? id : null;
    }

    // Rollups count inbound relation links. When sourceColumnId names a live relation column that
    // targets this table, only links through that relation are counted; otherwise every inbound
    // relation link is counted (the historical default).
    function incomingRelations(tableId, rowId, sourceColumnId) {
      if (sourceColumnId) {
        const source = featureState.tables.find((candidate) => candidate.columns.some((column) =>
          column.id === sourceColumnId && column.type === "relation" && column.targetTableId === tableId));
        const column = source?.columns.find((item) => item.id === sourceColumnId);
        if (source && column) return source.rows.filter((row) => row.values[column.id] === rowId).length;
      }
      let count = 0;
      featureState.tables.forEach((source) => source.columns.filter((column) =>
        column.type === "relation" && column.targetTableId === tableId
      ).forEach((column) => {
        count += source.rows.filter((row) => row.values[column.id] === rowId).length;
      }));
      return count;
    }

    // Relation columns in any table that point at the given table: the valid scopes for a rollup.
    function rollupSources(table) {
      const sources = [];
      featureState.tables.forEach((sourceTable) => sourceTable.columns
        .filter((column) => column.type === "relation" && column.targetTableId === table.id)
        .forEach((column) => sources.push({ id: column.id, label: `${sourceTable.name} · ${column.name}` })));
      return sources;
    }

    function renderQueryHelp() {
      const panel = el("div", "query-help");
      panel.hidden = !queryHelpOpen;
      const examples = [
        ["LIST FROM notes", "One line per matching note."],
        ["TABLE title,folder,tags FROM notes", "Columns: title, folder, pinned, created, updated, parent, tags."],
        ["LIST FROM notes WHERE title = \"Exact title\"", "Exact match, case-insensitive."],
        ["LIST FROM notes WHERE title CONTAINS \"part\"", "Substring match. Also works with folder."],
        ["LIST FROM notes WHERE folder = \"Work\"", "Matches the folder name."],
        ["LIST FROM notes WHERE tag = work", "Matches notes tagged #work (#work works too)."],
        ["LIST FROM notes WHERE pinned = true", "Pinned notes; use false for the rest."],
        ["LIST FROM notes WHERE tag = work AND pinned = true", "AND binds tighter than OR; combine several conditions."],
        ["LIST FROM notes WHERE created >= 2026-11-01 ORDER BY updated DESC LIMIT 10", "Date comparisons, sorting, and a result cap."]
      ];
      examples.forEach(([syntax, meaning]) => {
        const item = el("div", "query-help-item");
        item.append(el("code", "", syntax), el("span", "", meaning));
        panel.append(item);
      });
      panel.append(el("p", "feature-help", "Combine conditions with AND / OR, sort with ORDER BY field ASC|DESC, cap results with LIMIT n. Click a result to open the note."));
      return panel;
    }

    function renderQuery() {
      const sectionEl = el("section", "dataview-panel");
      const intro = el("div");
      intro.append(el("h3", "", "Note query"), el("p", "", "Read-only grammar: LIST or TABLE fields FROM notes, optionally WHERE conditions joined by AND/OR, ORDER BY field ASC|DESC, LIMIT n."));
      const controls = el("div", "query-controls");
      const input = el("input", "feature-input query-input");
      input.value = featureState.query;
      input.maxLength = 500;
      input.setAttribute("aria-label", "Safe note query");
      input.dataset.action = "query-input";
      const help = el("button", "feature-button", "?");
      help.type = "button";
      help.dataset.action = "query-help";
      help.title = "Query grammar reference";
      help.setAttribute("aria-label", "Toggle query grammar reference");
      const run = el("button", "feature-button", "Run query");
      run.type = "button";
      run.dataset.action = "run-query";
      controls.append(input, help, run);
      sectionEl.append(intro, controls, renderQueryHelp());
      const result = el("div", "query-results");
      if (queryResult) result.append(queryResult);
      sectionEl.append(result);
      return sectionEl;
    }

    function toggleQueryHelp() {
      queryHelpOpen = !queryHelpOpen;
      render();
    }

    function runQuery() {
      const raw = featureState.query.trim();
      // Phase 3 (query v2) — AND/OR, ORDER BY, LIMIT, date comparisons.
      // The grammar stays regex + allowlist; the parser lives in phase3.js.
      if (window.xPinPhase3?.parseQueryV2 && window.xPinPhase3?.runQueryV2) {
        let parsed;
        try {
          parsed = window.xPinPhase3.parseQueryV2(raw);
        } catch (error) {
          throw error;
        }
        const notes = window.xPinPhase3.runQueryV2(host.getState().notes, host.getState().folders, host.extractTags, parsed);
        const mode = parsed.mode;
        const fields = parsed.fields;
        const results = el("div", mode === "TABLE" ? "query-table-results" : "query-list-results");
        notes.forEach((note) => {
          const row = el("button", "query-result-row");
          row.type = "button";
          row.addEventListener("click", () => {
            deactivate();
            host.selectNote(note.id);
          });
          fields.forEach((field) => {
            const folder = host.getState().folders.find((item) => item.id === note.folderId)?.name ?? "Unfiled";
            const values = {
              title: note.title || "Untitled note",
              folder,
              pinned: note.pinned ? "Pinned" : "—",
              created: formatDate(note.createdAt),
              updated: formatDate(note.updatedAt),
              parent: host.getState().notes.find((item) => item.id === note.parentNoteId)?.title ?? "—",
              tags: host.extractTags(`${note.title}\n${note.body}`).join(", ") || "—"
            };
            row.append(el("span", "query-result-field", values[field]));
          });
          results.append(row);
        });
        if (!notes.length) results.append(el("p", "feature-empty", "No notes match this query."));
        queryResult = results;
        render();
        return;
      }
      const match = raw.match(/^(LIST|TABLE(?:\s+([a-zA-Z, ]+))?)\s+FROM\s+notes(?:\s+WHERE\s+(title|folder|tag|pinned)\s*(=|CONTAINS)\s*(.+))?$/i);
      if (!match) throw new TypeError("Use LIST FROM notes or TABLE title,folder FROM notes with one supported WHERE condition.");
      const mode = match[1].toLocaleUpperCase().startsWith("TABLE") ? "TABLE" : "LIST";
      const fields = mode === "LIST" ? ["title"] : (match[2] || "title").split(",").map((field) => field.trim().toLocaleLowerCase());
      const allowed = new Set(["title", "folder", "pinned", "created", "updated", "parent", "tags"]);
      if (!fields.length || fields.some((field) => !allowed.has(field))) {
        throw new TypeError("Query fields must be title, folder, pinned, created, updated, parent, or tags.");
      }
      const filterField = match[3]?.toLocaleLowerCase();
      const operator = match[4]?.toLocaleUpperCase();
      const value = match[5]?.trim().replace(/^["']|["']$/g, "");
      if (operator === "CONTAINS" && filterField !== "title" && filterField !== "folder") {
        throw new TypeError("CONTAINS works only with title or folder.");
      }
      if (filterField === "pinned" && !["true", "false"].includes(value?.toLocaleLowerCase())) {
        throw new TypeError("Pinned filters use true or false.");
      }
      const notes = host.getState().notes.filter((note) => {
        if (!filterField) return true;
        const folder = host.getState().folders.find((item) => item.id === note.folderId)?.name ?? "";
        const current = filterField === "title" ? note.title
          : filterField === "folder" ? folder
            : filterField === "pinned" ? String(note.pinned)
              : filterField === "tag" ? note.body : "";
        if (filterField === "tag") {
          // extractTags returns tags with a # prefix, so accept the value with or without it.
          const wanted = value.toLocaleLowerCase();
          const normalized = wanted.startsWith("#") ? wanted : `#${wanted}`;
          return host.extractTags(`${note.title}\n${note.body}`).includes(normalized);
        }
        if (filterField === "pinned") return current.toLocaleLowerCase() === value.toLocaleLowerCase();
        return operator === "CONTAINS"
          ? current.toLocaleLowerCase().includes(value.toLocaleLowerCase())
          : current.toLocaleLowerCase() === value.toLocaleLowerCase();
      });
      const results = el("div", mode === "TABLE" ? "query-table-results" : "query-list-results");
      notes.forEach((note) => {
        const row = el("button", "query-result-row");
        row.type = "button";
        row.addEventListener("click", () => {
          deactivate();
          host.selectNote(note.id);
        });
        fields.forEach((field) => {
          const folder = host.getState().folders.find((item) => item.id === note.folderId)?.name ?? "Unfiled";
          const values = {
            title: note.title || "Untitled note",
            folder,
            pinned: note.pinned ? "Pinned" : "—",
            created: formatDate(note.createdAt),
            updated: formatDate(note.updatedAt),
            parent: host.getState().notes.find((item) => item.id === note.parentNoteId)?.title ?? "—",
            tags: host.extractTags(`${note.title}\n${note.body}`).join(", ") || "—"
          };
          row.append(el("span", "query-result-field", values[field]));
        });
        results.append(row);
      });
      if (!notes.length) results.append(el("p", "feature-empty", "No notes match this query."));
      queryResult = results;
      render();
    }

    // Phase 3 (Graph v2) — local-graph view, zoom/pan, tag + folder
    // filters, orphan detection. The 150-node cap is shown honestly.
    let graphZoom = 1;
    let graphPan = { x: 0, y: 0 };
    let graphScope = "full"; // "full" | "local"
    let graphHops = 1;
    let graphTagFilter = "";
    let graphFolderFilter = "";
    let graphOrphansOnly = false;

    function renderGraph() {
      const allNotes = host.getState().notes;
      const wrapper = el("div", "graph-workspace");
      wrapper.append(el("p", "feature-help", "Links use [[exact note titles]]. Parent-page relationships also create connections."));
      if (!allNotes.length) {
        wrapper.append(el("p", "feature-empty", "Create a note to add the first node."));
        return wrapper;
      }
      // Controls: scope, hops, zoom, filters, orphans.
      const controls = el("div", "graph-controls");
      const scopeSelect = el("select", "feature-select");
      scopeSelect.setAttribute("aria-label", "Graph scope");
      [["full", "Full graph"], ["local", "Local graph (current note)"]].forEach(([value, label]) => {
        const option = el("option", "", label);
        option.value = value;
        if (value === graphScope) option.selected = true;
        scopeSelect.append(option);
      });
      scopeSelect.addEventListener("change", () => { graphScope = scopeSelect.value; render(); });
      const hopsSelect = el("select", "feature-select");
      hopsSelect.setAttribute("aria-label", "Local graph hops");
      [[1, "1 hop"], [2, "2 hops"]].forEach(([value, label]) => {
        const option = el("option", "", label);
        option.value = String(value);
        if (value === graphHops) option.selected = true;
        hopsSelect.append(option);
      });
      hopsSelect.addEventListener("change", () => { graphHops = Number(hopsSelect.value); render(); });
      hopsSelect.disabled = graphScope !== "local";
      const zoomOut = el("button", "feature-button", "−");
      zoomOut.type = "button";
      zoomOut.setAttribute("aria-label", "Zoom out");
      zoomOut.addEventListener("click", () => { graphZoom = Math.max(0.25, graphZoom - 0.25); render(); });
      const zoomLabel = el("output", "graph-zoom", `${Math.round(graphZoom * 100)}%`);
      const zoomIn = el("button", "feature-button", "＋");
      zoomIn.type = "button";
      zoomIn.setAttribute("aria-label", "Zoom in");
      zoomIn.addEventListener("click", () => { graphZoom = Math.min(3, graphZoom + 0.25); render(); });
      const zoomReset = el("button", "feature-button", "Reset view");
      zoomReset.type = "button";
      zoomReset.addEventListener("click", () => { graphZoom = 1; graphPan = { x: 0, y: 0 }; render(); });
      const tagSelect = el("select", "feature-select");
      tagSelect.setAttribute("aria-label", "Filter graph by tag");
      const allTags = [...new Set(allNotes.flatMap((note) => host.extractTags(`${note.title}\n${note.body}`)))].sort();
      const noTag = el("option", "", "All tags");
      noTag.value = "";
      tagSelect.append(noTag);
      allTags.forEach((tag) => {
        const option = el("option", "", tag);
        option.value = tag;
        if (tag === graphTagFilter) option.selected = true;
        tagSelect.append(option);
      });
      tagSelect.addEventListener("change", () => { graphTagFilter = tagSelect.value; render(); });
      const folderSelect = el("select", "feature-select");
      folderSelect.setAttribute("aria-label", "Filter graph by folder");
      const noFolder = el("option", "", "All folders");
      noFolder.value = "";
      folderSelect.append(noFolder);
      host.getState().folders.forEach((folder) => {
        const option = el("option", "", folder.name);
        option.value = folder.id;
        if (folder.id === graphFolderFilter) option.selected = true;
        folderSelect.append(option);
      });
      folderSelect.addEventListener("change", () => { graphFolderFilter = folderSelect.value; render(); });
      const orphanLabel = el("label", "graph-orphan-toggle");
      const orphanCheck = el("input");
      orphanCheck.type = "checkbox";
      orphanCheck.checked = graphOrphansOnly;
      orphanCheck.addEventListener("change", () => { graphOrphansOnly = orphanCheck.checked; render(); });
      orphanLabel.append(orphanCheck, el("span", "", "Orphans only"));
      controls.append(scopeSelect, hopsSelect, zoomOut, zoomLabel, zoomIn, zoomReset, tagSelect, folderSelect, orphanLabel);
      wrapper.append(controls);

      // Data: full or local graph, then tag/folder/orphan filters.
      const P3 = window.xPinPhase3;
      let graph = P3?.buildGraph ? P3.buildGraph(allNotes, 150) : { nodes: allNotes.slice(0, 150).map((n) => ({ id: n.id, title: n.title })), edges: [], capped: allNotes.length > 150, total: allNotes.length };
      if (graphScope === "local" && host.currentNote?.()?.id && P3?.localGraph) {
        graph = P3.localGraph(allNotes, host.currentNote().id, graphHops);
      }
      let visibleIds = new Set(graph.nodes.map((n) => n.id));
      if (graphOrphansOnly && P3?.findOrphans) {
        const orphanIds = new Set(P3.findOrphans(allNotes).map((n) => n.id));
        visibleIds = new Set([...visibleIds].filter((id) => orphanIds.has(id)));
      }
      if (graphTagFilter) {
        visibleIds = new Set([...visibleIds].filter((id) => {
          const note = allNotes.find((n) => n.id === id);
          return note && host.extractTags(`${note.title}\n${note.body}`).includes(graphTagFilter);
        }));
      }
      if (graphFolderFilter) {
        visibleIds = new Set([...visibleIds].filter((id) => {
          const note = allNotes.find((n) => n.id === id);
          return note && note.folderId === graphFolderFilter;
        }));
      }
      const visibleNodes = graph.nodes.filter((n) => visibleIds.has(n.id));
      const visibleEdges = graph.edges.filter(([a, b]) => visibleIds.has(a) && visibleIds.has(b));
      if (!visibleNodes.length) {
        wrapper.append(el("p", "feature-empty", graphScope === "local"
          ? "The current note has no linked neighbours in this range."
          : "No notes match these graph filters."));
        return wrapper;
      }
      const stage = el("div", "graph-stage");
      const canvas = el("div", "graph-canvas");
      canvas.style.transform = `translate(${graphPan.x}px, ${graphPan.y}px) scale(${graphZoom})`;
      const edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      edges.classList.add("graph-edges");
      edges.setAttribute("viewBox", "0 0 1000 600");
      const positions = new Map(visibleNodes.map((node, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(1, visibleNodes.length);
        return [node.id, { x: 500 + Math.cos(angle) * Math.min(360, 100 + visibleNodes.length * 4), y: 300 + Math.sin(angle) * Math.min(220, 80 + visibleNodes.length * 2) }];
      }));
      const edgeKeys = new Set();
      visibleEdges.forEach(([fromId, toId]) => {
        const key = [fromId, toId].sort().join(":");
        if (edgeKeys.has(key)) return;
        edgeKeys.add(key);
        const from = positions.get(fromId);
        const to = positions.get(toId);
        if (!from || !to) return;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(from.x));
        line.setAttribute("y1", String(from.y));
        line.setAttribute("x2", String(to.x));
        line.setAttribute("y2", String(to.y));
        edges.append(line);
      });
      canvas.append(edges);
      visibleNodes.forEach((node) => {
        const note = allNotes.find((n) => n.id === node.id);
        const point = positions.get(node.id);
        const button = el("button", "graph-node", note?.title?.trim() || "Untitled note");
        button.type = "button";
        button.style.left = `${point.x / 10}%`;
        button.style.top = `${point.y / 6}%`;
        button.addEventListener("click", () => {
          deactivate();
          host.selectNote(node.id);
        });
        canvas.append(button);
      });
      stage.append(canvas);
      // Pan: drag the background. Wheel: zoom.
      let dragging = null;
      stage.addEventListener("mousedown", (event) => {
        if (event.target !== stage && event.target !== canvas && event.target.tagName !== "svg") return;
        dragging = { x: event.clientX - graphPan.x, y: event.clientY - graphPan.y };
      });
      stage.addEventListener("mousemove", (event) => {
        if (!dragging) return;
        graphPan = { x: event.clientX - dragging.x, y: event.clientY - dragging.y };
        canvas.style.transform = `translate(${graphPan.x}px, ${graphPan.y}px) scale(${graphZoom})`;
      });
      stage.addEventListener("mouseup", () => { dragging = null; });
      stage.addEventListener("mouseleave", () => { dragging = null; });
      stage.addEventListener("wheel", (event) => {
        event.preventDefault();
        graphZoom = Math.max(0.25, Math.min(3, graphZoom + (event.deltaY < 0 ? 0.1 : -0.1)));
        canvas.style.transform = `translate(${graphPan.x}px, ${graphPan.y}px) scale(${graphZoom})`;
        zoomLabel.textContent = `${Math.round(graphZoom * 100)}%`;
      }, { passive: false });
      wrapper.append(stage);
      if (graph.capped || allNotes.length > 150) wrapper.append(el("small", "feature-help", `Showing the first 150 of ${allNotes.length} notes.`));
      else if (visibleNodes.length < graph.nodes.length) wrapper.append(el("small", "feature-help", `Showing ${visibleNodes.length} of ${graph.nodes.length} notes in this view.`));
      return wrapper;
    }


    function renderSettings() {
      const wrap = el("div", "workspace-tools");
      const appearance = el("section", "tools-section");
      appearance.append(el("h2", "", "Appearance"), el("p", "", "Tune validated color and density tokens. Arbitrary CSS is not loaded."));
      const controls = el("div", "appearance-controls");
      const accentLabel = el("label", "", "Accent");
      const accent = el("select", "feature-select");
      accent.setAttribute("aria-label", "Accent color");
      Object.keys(ACCENTS).forEach((name) => {
        const option = el("option", "", name[0].toLocaleUpperCase() + name.slice(1));
        option.value = name;
        accent.append(option);
      });
      accent.value = featureState.theme.accent;
      accent.dataset.action = "accent";
      accentLabel.append(accent);
      const densityLabel = el("label", "", "Layout density");
      const density = el("select", "feature-select");
      [["comfortable", "Comfortable"], ["compact", "Compact"]].forEach(([value, label]) => {
        const option = el("option", "", label);
        option.value = value;
        density.append(option);
      });
      density.value = featureState.theme.density;
      density.dataset.action = "density";
      densityLabel.append(density);
      controls.append(accentLabel, densityLabel);
      appearance.append(controls);
      wrap.append(appearance);

      // M4 — storage usage: how much is stored, where, and that a backup copy exists.
      const storage = el("section", "tools-section");
      const info = typeof host.storageInfo === "function" ? host.storageInfo() : null;
      storage.append(el("h2", "", "Storage"), el("p", "", info
        ? `${info.notes} ${info.notes === 1 ? "note" : "notes"} · ${info.trash} in Trash · about ${info.displayBytes} stored in ${info.backend === "indexeddb" ? "IndexedDB" : "localStorage (IndexedDB is unavailable here)"}${info.attachments ? ` · ${info.attachments} attachment${info.attachments === 1 ? "" : "s"} (${info.attachmentDisplayBytes})` : ""}. A backup copy is kept in localStorage, and if saving ever fails xPin offers a Markdown backup download instead of losing edits.`
        : "Storage details are unavailable."));
      wrap.append(storage);

      const publishing = el("section", "tools-section");
      publishing.append(el("h2", "", "Static page export"), el("p", "", "Download the selected note as a standalone HTML file. Host it yourself to make it public; xPin does not upload it."));
      const publish = el("button", "feature-button feature-button-primary", "Export current page");
      publish.type = "button";
      publish.dataset.action = "publish";
      publishing.append(publish);
      wrap.append(publishing);

      // M3 — Markdown export: portable .md files with frontmatter, folders
      // preserved inside the .zip, Trash included under Trash/.
      const markdown = el("section", "tools-section");
      markdown.append(el("h2", "", "Markdown export"), el("p", "", "Download notes as plain .md files — properties included as frontmatter — so they open in any notes app."));
      const markdownActions = el("div", "backup-actions");
      const markdownNote = el("button", "feature-button", "Export current note (.md)");
      markdownNote.type = "button";
      markdownNote.dataset.action = "markdown-note";
      const markdownZip = el("button", "feature-button feature-button-primary", "Export all notes (.zip)");
      markdownZip.type = "button";
      markdownZip.dataset.action = "markdown-zip";
      markdownActions.append(markdownNote, markdownZip);
      markdown.append(markdownActions);
      wrap.append(markdown);

      const backup = el("section", "tools-section");
      backup.append(el("h2", "", "Encrypted workspace handoff"), el("p", "", "Export/import a passphrase-encrypted file. This is not live sync; keep your passphrase safe because it cannot be recovered."));
      const backupActions = el("div", "backup-actions");
      const exportButton = el("button", "feature-button", "Export encrypted backup");
      exportButton.type = "button";
      exportButton.dataset.action = "backup-export";
      const importButton = el("button", "feature-button", "Import encrypted backup");
      importButton.type = "button";
      importButton.dataset.action = "backup-import";
      const fileInput = el("input");
      fileInput.type = "file";
      fileInput.accept = ".xPin-backup,application/json";
      fileInput.hidden = true;
      fileInput.dataset.action = "backup-file";
      backupActions.append(exportButton, importButton, fileInput);
      backup.append(backupActions);
      wrap.append(backup);

      const synced = el("section", "tools-section synced-blocks-section");
      const syncedHeader = el("div", "feature-page-header");
      const copy = el("div");
      copy.append(el("h2", "", "Shared blocks"), el("p", "", "Edit a source once; every {{sync:id}} reference displays the same text in preview."));
      const addBlock = el("button", "feature-button", "＋ Shared block");
      addBlock.type = "button";
      addBlock.dataset.action = "new-synced-block";
      syncedHeader.append(copy, addBlock);
      synced.append(syncedHeader);
      if (!featureState.syncedBlocks.length) synced.append(el("p", "feature-empty", "No shared blocks yet."));
      featureState.syncedBlocks.forEach((block) => {
        const card = el("article", "synced-block-item");
        const title = el("input", "feature-input");
        title.value = block.title;
        title.maxLength = 100;
        title.dataset.action = "synced-title";
        title.dataset.blockId = block.id;
        title.setAttribute("aria-label", "Shared block title");
        const body = el("textarea", "feature-input synced-block-content");
        body.value = block.content;
        body.maxLength = 20_000;
        body.dataset.action = "synced-content";
        body.dataset.blockId = block.id;
        body.setAttribute("aria-label", `Shared block ${block.title}`);
        const remove = el("button", "database-row-remove", "Remove");
        remove.type = "button";
        remove.dataset.action = "delete-synced-block";
        remove.dataset.blockId = block.id;
        card.append(title, body, remove);
        synced.append(card);
      });
      wrap.append(synced);
      const pluginNote = el("p", "feature-help", "The local plugin catalogue remains under Plugins. Uploaded packages are not fetched from a remote marketplace and stay disabled until reviewed.");
      wrap.append(pluginNote);
      return wrap;
    }

    function render() {
      if (!active) return;
      if (active === "database") renderDatabase();
      else if (active === "graph") content.replaceChildren(renderGraph());
      else content.replaceChildren(renderSettings());
      applyTheme();
    }

    function applyTheme() {
      const [accent, bright] = ACCENTS[featureState.theme.accent] ?? ACCENTS.cyan;
      document.documentElement.style.setProperty("--cyan", accent);
      document.documentElement.style.setProperty("--cyan-bright", bright);
      document.documentElement.dataset.xPinDensity = featureState.theme.density;
    }

    function addRow(table) {
      const values = {};
      table.columns.forEach((column) => {
        if (column.type === "status") values[column.id] = "Not started";
      });
      table.rows.push({ id: makeId("row"), values });
      emit("database:row:changed", { tableId: table.id, rowId: table.rows[table.rows.length - 1].id, action: "added" });
      save();
      render();
      content.querySelector(".database-cell-input")?.focus();
    }

    async function addTable() {
      const name = await window.xPinPhase3?.showDialog(document, {
        title: "New database", label: "Database name", value: "", placeholder: "e.g. Projects", confirmLabel: "Create"
      });
      if (name === null || name === undefined) return;
      const clean = name.trim().slice(0, 80);
      if (!clean) return host.notify("Database names cannot be empty.");
      const table = {
        id: makeId("db"),
        name: clean,
        view: "table",
        columns: [makeColumn(makeId("field"), "Name", "text"), makeColumn(makeId("field"), "Status", "status")],
        rows: []
      };
      featureState.tables.push(table);
      emit("database:created", { id: table.id, name: table.name });
      save();
      render();
    }

    async function renameTable(table) {
      const name = await window.xPinPhase3?.showDialog(document, {
        title: "Rename database", label: "Database name", value: table.name, confirmLabel: "Rename"
      });
      if (name === null || name === undefined) return;
      const clean = name.trim().slice(0, 80);
      if (!clean) return host.notify("Database names cannot be empty.");
      table.name = clean;
      emit("database:updated", { id: table.id, name: table.name });
      save();
      render();
    }

    function removeTable(table) {
      if (!window.confirm(`Delete the database "${table.name}"? This removes ${table.rows.length} ${table.rows.length === 1 ? "record" : "records"} and cannot be undone.`)) return;
      // Relation columns in other tables that pointed at the deleted table are dropped too,
      // mirroring what sanitizeState does with dangling relation targets on load.
      const droppedIds = new Set();
      featureState.tables.forEach((source) => {
        source.columns.filter((column) => column.type === "relation" && column.targetTableId === table.id)
          .forEach((column) => droppedIds.add(column.id));
      });
      if (droppedIds.size) {
        featureState.tables.forEach((source) => {
          source.columns = source.columns.filter((column) => !droppedIds.has(column.id));
          source.rows.forEach((row) => droppedIds.forEach((id) => delete row.values[id]));
          source.columns.forEach((column) => {
            if (column.type === "rollup" && column.sourceColumnId && droppedIds.has(column.sourceColumnId)) {
              delete column.sourceColumnId;
            }
          });
          if (!source.columns.length) source.columns.push(makeColumn(makeId("field"), "Name", "text"));
        });
      }
      featureState.tables = featureState.tables.filter((candidate) => candidate.id !== table.id);
      if (featureState.selectedTableId === table.id) featureState.selectedTableId = featureState.tables[0]?.id ?? null;
      emit("database:deleted", { id: table.id, name: table.name });
      save();
      render();
    }

    async function renameColumn(table) {
      const column = columnById(table, content.querySelector('[data-role="manage-column"]')?.value);
      if (!column) return;
      const name = await window.xPinPhase3?.showDialog(document, {
        title: "Rename property", label: "Property name", value: column.name, confirmLabel: "Rename"
      });
      if (name === null || name === undefined) return;
      const clean = name.trim().slice(0, 80);
      if (!clean) return host.notify("Property names cannot be empty.");
      if (table.columns.some((candidate) => candidate.id !== column.id &&
        candidate.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
        return host.notify("This database already has a property with that name.");
      }
      column.name = clean;
      save();
      render();
    }

    function removeColumn(table) {
      const column = columnById(table, content.querySelector('[data-role="manage-column"]')?.value);
      if (!column) return;
      if (table.columns.length === 1) return host.notify("A database needs at least one property.");
      if (!window.confirm(`Delete the property "${column.name}"? All of its values will be removed.`)) return;
      table.columns = table.columns.filter((candidate) => candidate.id !== column.id);
      table.rows.forEach((row) => delete row.values[column.id]);
      featureState.tables.forEach((source) => source.columns.forEach((item) => {
        if (item.type === "rollup" && item.sourceColumnId === column.id) delete item.sourceColumnId;
      }));
      save();
      render();
    }

    function addColumn(table) {
      const input = content.querySelector('[data-role="new-column-name"]');
      const typeInput = content.querySelector('[data-role="new-column-type"]');
      const name = input?.value.trim().slice(0, 80);
      const type = typeInput?.value;
      if (!name) return host.notify("Enter a property name first.");
      if (!COLUMN_TYPES.includes(type)) return host.notify("Choose a supported property type.");
      if (table.columns.some((column) => column.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return host.notify("This database already has a property with that name.");
      }
      const column = makeColumn(makeId("field"), name, type);
      if (type === "relation") {
        column.targetTableId = content.querySelector('[data-role="new-column-target"]')?.value ?? "notes";
        if (column.targetTableId !== "notes" && !tableById(column.targetTableId)) {
          return host.notify("Choose an existing relation target.");
        }
      }
      if (type === "rollup") {
        column.aggregation = "count";
        const sourceId = content.querySelector('[data-role="new-column-source"]')?.value;
        if (sourceId && rollupSources(table).some((item) => item.id === sourceId)) {
          column.sourceColumnId = sourceId;
        }
      }
      // Phase 3 (Databases v2) — formula columns store a safe expression
      // (e.g. "= price * qty", "= days(due, today())"). Only parse errors
      // are rejected here; value errors (missing field, empty cell) show
      // per-row at render time instead of blocking creation.
      if (type === "formula") {
        const expression = content.querySelector('[data-role="new-column-expression"]')?.value?.trim() ?? "";
        if (!expression) return host.notify("Enter a formula, for example: = price * qty");
        const check = window.xPinPhase3?.evaluateFormula(expression, { values: {} }, table.columns);
        if (check && !check.ok && !/unknown field|expected a number|divides by zero/i.test(check.error)) {
          return host.notify(`Formula problem: ${check.error}`);
        }
        column.expression = expression;
      }
      table.columns.push(column);
      save();
      render();
    }

    function removeRow(table, rowId) {
      table.rows = table.rows.filter((row) => row.id !== rowId);
      emit("database:row:changed", { tableId: table.id, rowId, action: "deleted" });
      featureState.tables.forEach((source) => source.columns.filter((column) =>
        column.type === "relation" && column.targetTableId === table.id
      ).forEach((column) => source.rows.forEach((row) => {
        if (row.values[column.id] === rowId) delete row.values[column.id];
      })));
      save();
      render();
    }

    function updateCell(event) {
      const target = event.target;
      const tablePicker = content.querySelector('[data-action="select-table"]');
      const table = tableById(tablePicker?.value);
      if (!table || !target.dataset.rowId || !target.dataset.columnId) return;
      const row = table.rows.find((item) => item.id === target.dataset.rowId);
      const column = columnById(table, target.dataset.columnId);
      if (!row || !column || column.type === "rollup" || column.type === "formula") return;
      let value = target.value;
      if (column.type === "text") value = value.slice(0, 2000);
      if (column.type === "number") {
        value = value === "" ? "" : Number(value);
        if (value !== "" && !Number.isFinite(value)) return host.notify("Enter a valid number.");
      }
      if (column.type === "relation" && value) {
        const exists = column.targetTableId === "notes"
          ? host.getState().notes.some((note) => note.id === value)
          : tableById(column.targetTableId)?.rows.some((item) => item.id === value);
        if (!exists) return host.notify("That related record no longer exists.");
      }
      if (value === "") delete row.values[column.id];
      else row.values[column.id] = value;
      // Row edits from a select (status/relation) commit on change; text
      // cells commit on every keystroke and are covered by save:completed
      // instead, so listeners are not spammed per keystroke.
      if (target.tagName === "SELECT") {
        emit("database:row:changed", { tableId: table.id, rowId: row.id, action: "updated" });
      }
      save();
      if (target.tagName === "SELECT") render();
    }

    function safeDownload(fileName, contents, type) {
      const url = URL.createObjectURL(new Blob([contents], { type }));
      const anchor = el("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function exportPage() {
      const note = host.currentNote();
      if (!note) return host.notify("Open a note before exporting a page.");
      host.flushSave();
      const title = note.title.trim() || "Untitled note";
      // M6 — render through the same Markdown renderer the in-app preview
      // uses, instead of dumping raw Markdown into the page.
      const rendered = typeof host.renderMarkdown === "function"
        ? host.renderMarkdown(note.body)
        : escapeHtml(note.body);
      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="A page exported from xPin"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>body{max-width:760px;margin:12vh auto;padding:0 24px;background:#07151d;color:#e8f4f6;font:17px/1.8 system-ui,sans-serif}h1{font-size:clamp(2rem,7vw,3.8rem);letter-spacing:-.05em;line-height:1.05}h2{font-size:1.5rem;margin-top:2.2em}h3{font-size:1.2rem;margin-top:1.8em}article{color:#b8cbd0}article p{margin:1em 0}article a{color:#54dce8}article ul,article ol{padding-left:1.4em}article li{margin:.35em 0}article blockquote{margin:1.2em 0;padding-left:1em;border-left:3px solid #54dce8;color:#8da7ac}article pre{background:#0a1f28;padding:14px;border-radius:8px;overflow:auto}article code{font:14px/1.6 ui-monospace,monospace}article pre code{background:none;padding:0}article table{border-collapse:collapse}article th,article td{padding:6px 12px;border:1px solid #294650;text-align:left}footer{margin-top:4rem;color:#8299a1;font-size:.8rem}</style></head><body><main><h1>${escapeHtml(title)}</h1><article>${rendered}</article><footer>Static page export · xPin</footer></main></body></html>`;
      safeDownload(`${title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "xPin-page"}.html`, html, "text/html;charset=utf-8");
      host.notify("Static HTML page exported. Host the file yourself to publish it.");
    }

    function bytesToBase64(bytes) {
      let binary = "";
      for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
      return btoa(binary);
    }

    function base64ToBytes(value) {
      const binary = atob(value);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }

    async function deriveKey(passphrase, salt) {
      const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 310_000, hash: "SHA-256" },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
    }

    async function exportBackup() {
      host.flushSave();
      if (!globalThis.crypto?.subtle) throw new Error("This browser does not support Web Crypto. Open xPin from localhost or a secure origin.");
      const passphrase = await window.xPinPhase3?.showDialog(document, {
        title: "Encrypted backup", message: "Choose a passphrase (at least 12 characters). It cannot be recovered.",
        label: "Passphrase", value: "", password: true, confirmLabel: "Export"
      });
      if (passphrase === null || passphrase === undefined) return;
      if (passphrase.length < 12) throw new TypeError("Use a passphrase with at least 12 characters.");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(passphrase, salt);
      const data = new TextEncoder().encode(JSON.stringify(host.getState()));
      if (data.length > 10_000_000) throw new TypeError("This workspace is too large for a single backup file (10 MB limit).");
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
      const payload = JSON.stringify({
        format: "xPin-encrypted-backup",
        version: 1,
        kdf: "PBKDF2-SHA-256",
        iterations: 310_000,
        cipher: "AES-256-GCM",
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(encrypted))
      }, null, 2);
      safeDownload("xPin-encrypted-backup.xPin-backup", payload, "application/json");
      host.notify("Encrypted backup exported. Keep the passphrase separate from the file.");
    }

    async function importBackup(file) {
      if (!file) return;
      if (file.size > 15_000_000) throw new TypeError("Backup file exceeds the 15 MB import limit.");
      if (!globalThis.crypto?.subtle) throw new Error("This browser does not support Web Crypto. Open xPin from localhost or a secure origin.");
      const envelope = JSON.parse(await file.text());
      if (!envelope || (envelope.format !== "xPin-encrypted-backup" && envelope.format !== "xpin-encrypted-backup") || envelope.version !== 1 ||
        envelope.kdf !== "PBKDF2-SHA-256" || envelope.cipher !== "AES-256-GCM" ||
        envelope.iterations !== 310_000 || typeof envelope.salt !== "string" ||
        typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
        throw new TypeError("This is not a supported xPin encrypted backup.");
      }
      const passphrase = await window.xPinPhase3?.showDialog(document, {
        title: "Import encrypted backup", label: "Backup passphrase", value: "", password: true, confirmLabel: "Import"
      });
      if (passphrase === null || passphrase === undefined) return;
      let clear;
      try {
        const key = await deriveKey(passphrase, base64ToBytes(envelope.salt));
        clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.ciphertext));
      } catch (error) {
        console.error("Could not decrypt xPin backup.", error);
        throw new Error("The passphrase is incorrect or this backup is damaged.");
      }
      const imported = JSON.parse(new TextDecoder().decode(clear));
      if (!imported || typeof imported !== "object" || !Array.isArray(imported.notes) ||
        !Array.isArray(imported.folders) || imported.notes.length > 20_000 || imported.folders.length > 2_000) {
        throw new TypeError("Decrypted workspace has an invalid or unsupported structure.");
      }
      const clean = {
        ...imported,
        features: sanitizeState(imported.features, imported.notes)
      };
      if (!window.confirm("Replace this device's current workspace with the imported backup? This cannot be undone.")) return;
      host.flushSave();
      localStorage.setItem(host.storageKey, JSON.stringify(clean));
      window.location.reload();
    }

    async function addSyncedBlock() {
      const title = await window.xPinPhase3?.showDialog(document, {
        title: "New shared block", label: "Block name", value: "", placeholder: "e.g. Weekly intro", confirmLabel: "Next"
      });
      if (title === null || title === undefined) return;
      const cleanTitle = title.trim().slice(0, 100);
      if (!cleanTitle) return host.notify("Give the shared block a name.");
      const contentText = await window.xPinPhase3?.showDialog(document, {
        title: "New shared block", label: "Shared text", value: "", multiline: true, confirmLabel: "Create"
      });
      if (contentText === null || contentText === undefined) return;
      if (contentText.length > 20_000) return host.notify("Shared blocks are limited to 20,000 characters.");
      const block = { id: makeId("sync"), title: cleanTitle, content: contentText };
      featureState.syncedBlocks.push(block);
      save();
      const note = host.currentNote() ?? host.createNote();
      if (note) host.insertText(`{{sync:${block.id}}}`);
      render();
    }

    function renderSlashMenu() {
      if (!slashMenu) {
        slashMenu = el("div", "slash-command-menu");
        slashMenu.setAttribute("role", "listbox");
        slashMenu.setAttribute("aria-label", "Insert a block");
        document.querySelector(".editor-fields").append(slashMenu);
      }
      slashMenu.replaceChildren();
      const commands = [
        ["heading", "Heading", "## "],
        ["task", "Task", "- [ ] "],
        ["quote", "Quote", "> "],
        ["code", "Code block", "```javascript\n\n```"],
        ["typed-task", "Task block", "```xpin-task\n{\"title\":\"\",\"status\":\"open\",\"due\":\"\",\"priority\":\"medium\"}\n```"],
        ["typed-person", "Person block", "```xpin-person\n{\"name\":\"\",\"role\":\"\",\"contact\":\"\"}\n```"],
        ["typed-project", "Project block", "```xpin-project\n{\"name\":\"\",\"status\":\"not started\",\"owner\":\"\",\"due\":\"\"}\n```"],
        ["typed-book", "Book block", "```xpin-book\n{\"title\":\"\",\"author\":\"\",\"status\":\"to read\",\"rating\":\"\"}\n```"],
        ["typed-idea", "Idea block", "```xpin-idea\n{\"title\":\"\",\"area\":\"\",\"energy\":\"medium\"}\n```"],
        ["script", "Script block", "```xpin-script\n// Runs only when you tap “Run script”, in the sandbox.\n// api.ui.notify(\"Hello from this note.\");\n```"],
        ["synced", "Shared block", ""]
      ];
      commands.forEach(([id, label, value]) => {
        const button = el("button", "slash-command-option", label);
        button.type = "button";
        button.setAttribute("role", "option");
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          const textarea = document.getElementById("note-body");
          const start = textarea.selectionStart;
          const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
          textarea.setRangeText(value || (featureState.syncedBlocks[0] ? `{{sync:${featureState.syncedBlocks[0].id}}}` : ""), lineStart, start, "end");
          if (id === "synced" && !featureState.syncedBlocks.length) {
            slashMenu.hidden = true;
            addSyncedBlock();
            return;
          }
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.focus();
          slashMenu.hidden = true;
        });
        slashMenu.append(button);
      });
      slashMenu.hidden = false;
    }

    function setup() {
      // Theme tokens must apply on boot, not only when a feature view renders.
      applyTheme();
      document.querySelectorAll("[data-feature-view]").forEach((button) => {
        button.addEventListener("click", () => open(button.dataset.featureView));
      });
      content.addEventListener("click", async (event) => {
        const action = event.target.closest("[data-action]")?.dataset.action;
        const table = tableById(content.querySelector('[data-action="select-table"]')?.value);
        try {
          if (action === "add-row" && table) addRow(table);
          else if (action === "add-table") addTable();
          else if (action === "add-column" && table) addColumn(table);
          else if (action === "rename-table" && table) renameTable(table);
          else if (action === "delete-table" && table) removeTable(table);
          else if (action === "rename-column" && table) renameColumn(table);
          else if (action === "delete-column" && table) removeColumn(table);
          else if (action === "delete-row" && table) {
            const rowElement = event.target.closest("[data-row-id]");
            const row = table.rows.find((item) => item.id === rowElement?.dataset.rowId);
            const label = row?.values[table.columns[0]?.id] || "this record";
            if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;
            removeRow(table, rowElement.dataset.rowId);
          }
          // Phase 3 (Databases v2) — date reminder on a row. In-app only:
          // it surfaces on the daily note for that date when the app opens.
          else if (action === "remind-row" && table) {
            const rowElement = event.target.closest("[data-row-id]");
            const row = table.rows.find((item) => item.id === rowElement?.dataset.rowId);
            const date = event.target.dataset.date;
            const phase3 = host.getState().phase3;
            if (row && date && phase3 && window.xPinPhase3?.createReminder) {
              const label = String(row.values[table.columns[0]?.id] ?? "Record");
              window.xPinPhase3.createReminder(phase3, { tableId: table.id, rowId: row.id, date, label });
              save();
              host.notify(`Reminder set for ${date} — it will appear on that day's daily note.`);
            }
          }
          else if (action === "run-query") runQuery();
          else if (action === "query-help") toggleQueryHelp();
          else if (action === "publish") exportPage();
          else if (action === "markdown-note" && typeof host.exportNoteMarkdown === "function") host.exportNoteMarkdown();
          else if (action === "markdown-zip" && typeof host.exportMarkdownZip === "function") host.exportMarkdownZip();
          else if (action === "backup-export") await exportBackup();
          else if (action === "backup-import") content.querySelector('[data-action="backup-file"]')?.click();
          else if (action === "new-synced-block") addSyncedBlock();
          else if (action === "delete-synced-block") {
            const id = event.target.closest("[data-block-id]").dataset.blockId;
            featureState.syncedBlocks = featureState.syncedBlocks.filter((block) => block.id !== id);
            save();
            render();
          }
        } catch (error) {
          console.error("xPin workspace tool failed.", error);
          host.notify(error.message || "This workspace action could not be completed.");
        }
      });
      content.addEventListener("change", (event) => {
        const target = event.target;
        const action = target.dataset.action;
        if (action === "select-table") {
          featureState.selectedTableId = target.value;
          save();
          render();
        }
        else if (action === "select-view") {
          const table = tableById(content.querySelector('[data-action="select-table"]')?.value);
          if (table && DATABASE_VIEWS.includes(target.value)) {
            table.view = target.value;
            save();
            render();
          }
        } else if (action === "cell-change") updateCell(event);
        // Phase 3 (Databases v2) — per-view sort / filter / group controls.
        else if (["view-sort", "view-sort-dir", "view-filter-column", "view-filter-op", "view-filter-value", "view-group"].includes(action)) {
          const table = tableById(content.querySelector('[data-action="select-table"]')?.value);
          const phase3 = host.getState().phase3;
          if (table && phase3) {
            if (!phase3.dbViews) phase3.dbViews = {};
            if (!phase3.dbViews[table.id]) {
              phase3.dbViews[table.id] = { sortColumnId: "", sortDir: "asc", filterColumnId: "", filterOp: "", filterValue: "", groupByColumnId: "" };
            }
            const view = phase3.dbViews[table.id];
            if (action === "view-sort") view.sortColumnId = target.value;
            if (action === "view-sort-dir") view.sortDir = target.value;
            if (action === "view-filter-column") view.filterColumnId = target.value;
            if (action === "view-filter-op") view.filterOp = target.value;
            if (action === "view-filter-value") view.filterValue = target.value.slice(0, 200);
            if (action === "view-group") view.groupByColumnId = target.value;
            save();
            render();
          }
        } else if (action === "accent" && Object.hasOwn(ACCENTS, target.value)) {
          featureState.theme.accent = target.value;
          emit("settings:changed", { section: "appearance", key: "accent" });
          save();
          applyTheme();
        } else if (action === "density" && ["comfortable", "compact"].includes(target.value)) {
          featureState.theme.density = target.value;
          emit("settings:changed", { section: "appearance", key: "density" });
          save();
          applyTheme();
        } else if (action === "backup-file") {
          const [file] = target.files ?? [];
          target.value = "";
          importBackup(file).catch((error) => {
            console.error("Could not import encrypted workspace backup.", error);
            host.notify(error.message || "Encrypted backup could not be imported.");
          });
        }
      });
      content.addEventListener("input", (event) => {
        const target = event.target;
        if (target.dataset.action === "cell-input") updateCell(event);
        // Phase 3 — filter value updates live (re-render on blur/change).
        if (target.dataset.action === "view-filter-value") {
          const table = tableById(content.querySelector('[data-action="select-table"]')?.value);
          const phase3 = host.getState().phase3;
          if (table && phase3?.dbViews?.[table.id]) {
            phase3.dbViews[table.id].filterValue = target.value.slice(0, 200);
            save();
          }
        }
        if (target.dataset.action === "query-input") {
          featureState.query = target.value.slice(0, 500);
          save();
        }
        if (target.dataset.action === "synced-title" || target.dataset.action === "synced-content") {
          const block = featureState.syncedBlocks.find((item) => item.id === target.dataset.blockId);
          if (!block) return;
          if (target.dataset.action === "synced-title") block.title = target.value.slice(0, 100);
          else block.content = target.value.slice(0, 20_000);
          save();
          if (target.dataset.action === "synced-content") host.render();
        }
      });
      const editor = document.getElementById("note-body");
      editor.addEventListener("input", () => {
        const before = editor.value.slice(0, editor.selectionStart);
        const line = before.slice(before.lastIndexOf("\n") + 1);
        if (line === "/") renderSlashMenu();
        else if (slashMenu) slashMenu.hidden = true;
      });
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && slashMenu && !slashMenu.hidden) {
          slashMenu.hidden = true;
          event.preventDefault();
        }
      });
      document.getElementById("create-child-page").addEventListener("click", () => {
        const note = host.currentNote();
        if (!note) return host.notify("Open a page first to create a sub-page.");
        host.createNote({ parentNoteId: note.id });
      });
      document.getElementById("insert-synced-block").addEventListener("click", async () => {
        if (!featureState.syncedBlocks.length) return addSyncedBlock();
        const selected = await window.xPinPhase3?.showDialog(document, {
          title: "Insert shared block",
          message: "Choose a shared block to insert, or create a new one.",
          label: "Shared block",
          value: featureState.syncedBlocks[0].id,
          options: [
            ...featureState.syncedBlocks.map((block, index) => ({ value: block.id, label: `${index + 1}. ${block.title}` })),
            { value: "__new__", label: "0. Create a new shared block" }
          ],
          confirmLabel: "Insert"
        });
        if (selected === null || selected === undefined) return;
        if (selected === "__new__") return addSyncedBlock();
        const block = featureState.syncedBlocks.find((item) => item.id === selected);
        if (!block) return host.notify("Choose a shared block from the list.");
        if (!host.currentNote()) host.createNote();
        host.insertText(`{{sync:${block.id}}}`);
      });
    }

    return { open, deactivate, render, setup, get active() { return Boolean(active); } };
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  window.xPinFeatures = { initialState, sanitizeState, create, escapeHtml };
})();
