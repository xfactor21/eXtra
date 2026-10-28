(() => {
  "use strict";

  const VIEW_NAMES = ["database", "graph", "settings"];
  const DATABASE_VIEWS = ["table", "board", "calendar", "gallery", "list", "timeline"];
  const COLUMN_TYPES = ["text", "status", "date", "number", "relation", "rollup"];
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
        if (column.type === "rollup") safe.aggregation = column.aggregation === "count" ? "count" : "count";
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
        database: ["Databases", "One set of records, six ways to see it."],
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
      controls.append(tablePicker, viewPicker, addRow, addTable);
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
      else if (table.view === "timeline") wrap.append(renderTimeline(table));
      else wrap.append(renderList(table));
      wrap.append(renderQuery());
      content.replaceChildren(wrap);
    }

    function fieldControl(table, row, column) {
      const value = row.values[column.id] ?? "";
      if (column.type === "rollup") {
        const badge = el("span", "rollup-value", String(incomingRelations(table.id, row.id)));
        badge.title = "Count of records in other tables related to this row.";
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

    function renderTable(table) {
      const container = el("div", "database-table-scroll");
      const tableElement = el("table", "database-table");
      const head = el("thead");
      const headerRow = el("tr");
      table.columns.forEach((column) => headerRow.append(el("th", "", column.name)));
      headerRow.append(el("th", "database-row-action-heading", " "));
      head.append(headerRow);
      const body = el("tbody");
      table.rows.forEach((row) => {
        const tr = el("tr");
        table.columns.forEach((column) => {
          const td = el("td");
          td.append(fieldControl(table, row, column));
          tr.append(td);
        });
        const actionCell = el("td");
        const remove = el("button", "database-row-remove", "×");
        remove.type = "button";
        remove.dataset.action = "delete-row";
        remove.dataset.rowId = row.id;
        remove.setAttribute("aria-label", "Delete row");
        actionCell.append(remove);
        tr.append(actionCell);
        body.append(tr);
      });
      if (!table.rows.length) {
        const tr = el("tr");
        const td = el("td", "database-empty-cell", "No records yet. Add a row, then connect it to another table.");
        td.colSpan = table.columns.length + 1;
        tr.append(td);
        body.append(tr);
      }
      tableElement.append(head, body);
      container.append(tableElement);
      const footer = el("div", "database-footer", `${table.rows.length} ${table.rows.length === 1 ? "record" : "records"} · ${table.columns.length} properties`);
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
        ["relation", "Relation to notes"], ["rollup", "Rollup count"]
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
      target.hidden = type.value !== "relation";
      type.addEventListener("change", () => { target.hidden = type.value !== "relation"; });
      const add = el("button", "feature-button", "＋ Property");
      add.type = "button";
      add.dataset.action = "add-column";
      fieldControls.append(name, type, target, add);
      const bottom = el("div", "database-table-bottom");
      bottom.append(footer, fieldControls);
      container.append(bottom);
      return container;
    }

    function valueText(table, row, column) {
      const value = row.values[column.id] ?? "";
      if (column.type === "rollup") return `${incomingRelations(table.id, row.id)} linked`;
      if (column.type === "relation") {
        if (column.targetTableId === "notes") return host.getState().notes.find((note) => note.id === value)?.title ?? "";
        const relatedTable = tableById(column.targetTableId);
        const relatedRow = relatedTable?.rows.find((item) => item.id === value);
        return relatedRow?.values[relatedTable.columns[0]?.id] ?? "";
      }
      return String(value);
    }

    function renderList(table) {
      const list = el("div", "database-record-list");
      table.rows.forEach((row) => {
        const item = el("article", "database-record-line");
        item.append(el("strong", "", row.values[table.columns[0]?.id] || "Untitled record"));
        const details = el("span");
        table.columns.slice(1).forEach((column) => {
          const value = valueText(table, row, column);
          if (value) details.append(el("span", "database-property-chip", `${column.name}: ${value}`));
        });
        item.append(details);
        list.append(item);
      });
      if (!table.rows.length) list.append(el("p", "feature-empty", "This view will fill as you add records."));
      return list;
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
        gallery.append(card);
      });
      if (!table.rows.length) gallery.append(el("p", "feature-empty", "Your gallery is ready for its first record."));
      return gallery;
    }

    function renderBoard(table) {
      const board = el("div", "database-board");
      STATUSES.forEach((status) => {
        const lane = el("section", "database-lane");
        const records = table.rows.filter((row) => (row.values[table.columns.find((column) => column.type === "status")?.id] ?? "Not started") === status);
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
        rows.forEach((row) => day.append(el("p", "", row.values[table.columns[0]?.id] || "Untitled record")));
        calendar.append(day);
      });
      if (!groups.size) calendar.append(el("p", "feature-empty", "Add dates to place records on the calendar."));
      return calendar;
    }

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
        item.style.setProperty("--timeline-index", String(index));
        timeline.append(item);
      });
      if (!rows.length) timeline.append(el("p", "feature-empty", "Set a due date to start a timeline."));
      return timeline;
    }

    function incomingRelations(tableId, rowId) {
      let count = 0;
      featureState.tables.forEach((source) => source.columns.filter((column) =>
        column.type === "relation" && column.targetTableId === tableId
      ).forEach((column) => {
        count += source.rows.filter((row) => row.values[column.id] === rowId).length;
      }));
      return count;
    }

    function renderQuery() {
      const sectionEl = el("section", "dataview-panel");
      const intro = el("div");
      intro.append(el("h3", "", "Note query"), el("p", "", "Read-only grammar: LIST or TABLE fields FROM notes, optionally WHERE title/folder/tag/pinned = value or title CONTAINS value."));
      const controls = el("div", "query-controls");
      const input = el("input", "feature-input query-input");
      input.value = featureState.query;
      input.maxLength = 500;
      input.setAttribute("aria-label", "Safe note query");
      input.dataset.action = "query-input";
      const run = el("button", "feature-button", "Run query");
      run.type = "button";
      run.dataset.action = "run-query";
      controls.append(input, run);
      sectionEl.append(intro, controls);
      const result = el("div", "query-results");
      if (queryResult) result.append(queryResult);
      sectionEl.append(result);
      return sectionEl;
    }

    function runQuery() {
      const raw = featureState.query.trim();
      const match = raw.match(/^(LIST|TABLE(?:\s+([a-zA-Z, ]+))?)\s+FROM\s+notes(?:\s+WHERE\s+(title|folder|tag|pinned)\s*(=|CONTAINS)\s*(.+))?$/i);
      if (!match) throw new TypeError("Use LIST FROM notes or TABLE title,folder FROM notes with one supported WHERE condition.");
      const mode = match[1].toLocaleUpperCase().startsWith("TABLE") ? "TABLE" : "LIST";
      const fields = mode === "LIST" ? ["title"] : (match[2] || "title").split(",").map((field) => field.trim());
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
        if (filterField === "tag") return host.extractTags(`${note.title}\n${note.body}`).includes(value.toLocaleLowerCase());
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
            created: new Date(note.createdAt).toLocaleDateString(),
            updated: new Date(note.updatedAt).toLocaleDateString(),
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

    function renderGraph() {
      const notes = host.getState().notes.slice(0, 150);
      const wrapper = el("div", "graph-workspace");
      wrapper.append(el("p", "feature-help", "Links use [[exact note titles]]. Parent-page relationships also create connections."));
      if (!notes.length) {
        wrapper.append(el("p", "feature-empty", "Create a note to add the first node."));
        return wrapper;
      }
      const stage = el("div", "graph-stage");
      const edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      edges.classList.add("graph-edges");
      edges.setAttribute("viewBox", "0 0 1000 600");
      const byTitle = new Map(notes.map((note) => [note.title.trim().toLocaleLowerCase(), note]));
      const positions = new Map(notes.map((note, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(1, notes.length);
        return [note.id, { x: 500 + Math.cos(angle) * Math.min(360, 100 + notes.length * 4), y: 300 + Math.sin(angle) * Math.min(220, 80 + notes.length * 2) }];
      }));
      const edgesList = [];
      const edgeKeys = new Set();
      notes.forEach((note) => {
        if (note.parentNoteId && positions.has(note.parentNoteId)) edgesList.push([note.parentNoteId, note.id]);
        for (const match of note.body.matchAll(/\[\[([^\]]{1,120})\]\]/g)) {
          const target = byTitle.get(match[1].trim().toLocaleLowerCase());
          if (target && target.id !== note.id) edgesList.push([note.id, target.id]);
        }
      });
      edgesList.forEach(([fromId, toId]) => {
        const key = [fromId, toId].sort().join(":");
        if (edgeKeys.has(key)) return;
        edgeKeys.add(key);
        const from = positions.get(fromId);
        const to = positions.get(toId);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(from.x));
        line.setAttribute("y1", String(from.y));
        line.setAttribute("x2", String(to.x));
        line.setAttribute("y2", String(to.y));
        edges.append(line);
      });
      stage.append(edges);
      notes.forEach((note) => {
        const point = positions.get(note.id);
        const button = el("button", "graph-node", note.title.trim() || "Untitled note");
        button.type = "button";
        button.style.left = `${point.x / 10}%`;
        button.style.top = `${point.y / 6}%`;
        button.addEventListener("click", () => {
          deactivate();
          host.selectNote(note.id);
        });
        stage.append(button);
      });
      wrapper.append(stage);
      if (host.getState().notes.length > 150) wrapper.append(el("small", "feature-help", "Showing the first 150 notes."));
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

      const publishing = el("section", "tools-section");
      publishing.append(el("h2", "", "Static page export"), el("p", "", "Download the selected note as a standalone HTML file. Host it yourself to make it public; Pinboard does not upload it."));
      const publish = el("button", "feature-button feature-button-primary", "Export current page");
      publish.type = "button";
      publish.dataset.action = "publish";
      publishing.append(publish);
      wrap.append(publishing);

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
      fileInput.accept = ".pinboard-backup,application/json";
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
      document.documentElement.dataset.pinboardDensity = featureState.theme.density;
    }

    function addRow(table) {
      const values = {};
      table.columns.forEach((column) => {
        if (column.type === "status") values[column.id] = "Not started";
      });
      table.rows.push({ id: makeId("row"), values });
      save();
      render();
      content.querySelector(".database-cell-input")?.focus();
    }

    function addTable() {
      const name = window.prompt("Name the new database:");
      if (name === null) return;
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
      if (type === "rollup") column.aggregation = "count";
      table.columns.push(column);
      save();
      render();
    }

    function removeRow(table, rowId) {
      table.rows = table.rows.filter((row) => row.id !== rowId);
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
      if (!row || !column || column.type === "rollup") return;
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
      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="A page exported from Pinboard"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>body{max-width:760px;margin:12vh auto;padding:0 24px;background:#07151d;color:#e8f4f6;font:17px/1.8 system-ui,sans-serif}h1{font-size:clamp(2rem,7vw,3.8rem);letter-spacing:-.05em;line-height:1.05}article{white-space:pre-wrap;overflow-wrap:anywhere;color:#b8cbd0}footer{margin-top:4rem;color:#8299a1;font-size:.8rem}</style></head><body><main><h1>${escapeHtml(title)}</h1><article>${escapeHtml(note.body)}</article><footer>Static page export · Pinboard</footer></main></body></html>`;
      safeDownload(`${title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pinboard-page"}.html`, html, "text/html;charset=utf-8");
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
      if (!globalThis.crypto?.subtle) throw new Error("This browser does not support Web Crypto. Open Pinboard from localhost or a secure origin.");
      const passphrase = window.prompt("Choose a passphrase (at least 12 characters). It cannot be recovered:");
      if (passphrase === null) return;
      if (passphrase.length < 12) throw new TypeError("Use a passphrase with at least 12 characters.");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(passphrase, salt);
      const data = new TextEncoder().encode(JSON.stringify(host.getState()));
      if (data.length > 10_000_000) throw new TypeError("This workspace is too large for a single backup file (10 MB limit).");
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
      const payload = JSON.stringify({
        format: "pinboard-encrypted-backup",
        version: 1,
        kdf: "PBKDF2-SHA-256",
        iterations: 310_000,
        cipher: "AES-256-GCM",
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(encrypted))
      }, null, 2);
      safeDownload("pinboard-encrypted-backup.pinboard-backup", payload, "application/json");
      host.notify("Encrypted backup exported. Keep the passphrase separate from the file.");
    }

    async function importBackup(file) {
      if (!file) return;
      if (file.size > 15_000_000) throw new TypeError("Backup file exceeds the 15 MB import limit.");
      if (!globalThis.crypto?.subtle) throw new Error("This browser does not support Web Crypto. Open Pinboard from localhost or a secure origin.");
      const envelope = JSON.parse(await file.text());
      if (!envelope || envelope.format !== "pinboard-encrypted-backup" || envelope.version !== 1 ||
        envelope.kdf !== "PBKDF2-SHA-256" || envelope.cipher !== "AES-256-GCM" ||
        envelope.iterations !== 310_000 || typeof envelope.salt !== "string" ||
        typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
        throw new TypeError("This is not a supported Pinboard encrypted backup.");
      }
      const passphrase = window.prompt("Enter the backup passphrase:");
      if (passphrase === null) return;
      let clear;
      try {
        const key = await deriveKey(passphrase, base64ToBytes(envelope.salt));
        clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.ciphertext));
      } catch (error) {
        console.error("Could not decrypt Pinboard backup.", error);
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

    function addSyncedBlock() {
      const title = window.prompt("Name this shared block:");
      if (title === null) return;
      const cleanTitle = title.trim().slice(0, 100);
      if (!cleanTitle) return host.notify("Give the shared block a name.");
      const contentText = window.prompt("Enter the shared text:");
      if (contentText === null) return;
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
          else if (action === "delete-row" && table) removeRow(table, event.target.closest("[data-row-id]").dataset.rowId);
          else if (action === "run-query") runQuery();
          else if (action === "publish") exportPage();
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
          console.error("Pinboard workspace tool failed.", error);
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
        else if (action === "accent" && Object.hasOwn(ACCENTS, target.value)) {
          featureState.theme.accent = target.value;
          save();
          applyTheme();
        } else if (action === "density" && ["comfortable", "compact"].includes(target.value)) {
          featureState.theme.density = target.value;
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
      document.getElementById("insert-synced-block").addEventListener("click", () => {
        if (!featureState.syncedBlocks.length) return addSyncedBlock();
        const choices = featureState.syncedBlocks.map((block, index) => `${index + 1}. ${block.title}`).join("\n");
        const selected = window.prompt(`Choose a shared block by number, or enter 0 to create one:\n${choices}`);
        if (selected === null) return;
        if (selected.trim() === "0") return addSyncedBlock();
        const index = Number.parseInt(selected, 10) - 1;
        const block = featureState.syncedBlocks[index];
        if (!block) return host.notify("Choose a number from the shared-block list.");
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

  window.PinboardFeatures = { initialState, sanitizeState, create, escapeHtml };
})();
