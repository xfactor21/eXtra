(() => {
  "use strict";

  const normalize = (value) => value.trim().toLocaleLowerCase();

  function makeNoteButton(note, api, prefix = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "plugin-note-link";
    button.textContent = `${prefix}${note.title.trim() || "Untitled note"}`;
    button.addEventListener("click", () => api.notes.select(note.id));
    return button;
  }

  function parseWikiLinks(text) {
    const links = [];
    const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
    for (const match of text.matchAll(pattern)) links.push(normalize(match[1]));
    return links;
  }

  function renderSection(title, notes, api, emptyMessage) {
    const section = document.createElement("section");
    section.className = "plugin-panel-section";
    const heading = document.createElement("h3");
    heading.textContent = `${title} · ${notes.length}`;
    section.append(heading);
    if (notes.length === 0) {
      const empty = document.createElement("p");
      empty.className = "plugin-panel-empty";
      empty.textContent = emptyMessage;
      section.append(empty);
      return section;
    }
    const list = document.createElement("div");
    list.className = "plugin-panel-links";
    notes.forEach((note) => list.append(makeNoteButton(note, api)));
    section.append(list);
    return section;
  }

  const plugins = [
    {
      id: "command-palette",
      name: "Command palette",
      description: "Search and run note actions from the keyboard.",
      category: "Navigation",
      defaultEnabled: true,
      activate(api) {
        api.commands.add({
          id: "open-plugins",
          name: "Open plugin manager",
          description: "Enable or disable Pinboard features.",
          run: api.ui.openPluginManager
        });
        api.commands.add({
          id: "new-note",
          name: "Create a new note",
          description: "Open a fresh page in your workspace.",
          run: () => api.notes.create()
        });
      }
    },
    {
      id: "daily-notes",
      name: "Daily notes",
      description: "Open today's page or create it once, then return to it.",
      category: "Writing",
      defaultEnabled: true,
      activate(api) {
        api.commands.add({
          id: "open-today",
          name: "Open today's note",
          description: "Find or create the page for today.",
          run: () => api.notes.openDaily()
        });
      }
    },
    {
      id: "templates",
      name: "Templates",
      description: "Insert a reusable structure into the current note.",
      category: "Writing",
      defaultEnabled: true,
      activate(api) {
        api.commands.add({
          id: "meeting-template",
          name: "Insert meeting notes template",
          description: "Add an agenda, notes, and next steps.",
          run: () => api.editor.insertText("## Agenda\n\n- \n\n## Notes\n\n\n## Next steps\n\n- ")
        });
        api.commands.add({
          id: "reflection-template",
          name: "Insert daily reflection template",
          description: "Make room for a highlight, a lesson, and tomorrow.",
          run: () => api.editor.insertText("## A good thing\n\n\n## Something I learned\n\n\n## One thing for tomorrow\n\n")
        });
      }
    },
    {
      id: "backlinks",
      name: "Backlinks",
      description: "Find notes that link to this page, plus its outgoing links.",
      category: "Reference",
      defaultEnabled: true,
      activate(api) {
        const records = new Map();
        const notesByTitle = new Map();
        const sourcesByTarget = new Map();
        const updateSet = (map, key, id, add) => {
          if (!key) return;
          const ids = map.get(key) ?? new Set();
          if (add) ids.add(id);
          else ids.delete(id);
          if (ids.size) map.set(key, ids);
          else map.delete(key);
        };
        const removeRecord = (id) => {
          const previous = records.get(id);
          if (!previous) return;
          updateSet(notesByTitle, normalize(previous.title), id, false);
          previous.links.forEach((target) => updateSet(sourcesByTarget, target, id, false));
          records.delete(id);
        };
        const upsertRecord = (note) => {
          if (!note || typeof note.id !== "string") return;
          removeRecord(note.id);
          const record = {
            id: note.id,
            title: typeof note.title === "string" ? note.title : "",
            body: typeof note.body === "string" ? note.body : "",
            links: parseWikiLinks(`${note.title ?? ""}\n${note.body ?? ""}`)
          };
          records.set(record.id, record);
          updateSet(notesByTitle, normalize(record.title), record.id, true);
          record.links.forEach((target) => updateSet(sourcesByTarget, target, record.id, true));
        };
        api.notes.list().forEach(upsertRecord);
        api.events.on("note:created", upsertRecord);
        api.events.on("note:updated", upsertRecord);
        api.events.on("note:deleted", (note) => removeRecord(note.id));
        api.ui.registerPanel({
          id: "backlinks",
          title: "Connections",
          render({ note, notes }) {
            const panel = document.createElement("div");
            panel.className = "plugin-panel-card connection-panel";
            if (!note) {
              panel.textContent = "Select a note to see its connections.";
              return panel;
            }
            const title = normalize(note.title);
            const incoming = [...(sourcesByTarget.get(title) ?? [])]
              .filter((id) => id !== note.id)
              .map((id) => records.get(id))
              .filter(Boolean);
            const currentLinks = records.get(note.id)?.links ?? parseWikiLinks(`${note.title}\n${note.body}`);
            const outgoingIds = new Set(currentLinks.flatMap((target) => [...(notesByTitle.get(target) ?? [])]));
            const outgoing = [...outgoingIds]
              .filter((id) => id !== note.id)
              .map((id) => records.get(id))
              .filter(Boolean);
            panel.append(
              renderSection("LINKED TO THIS NOTE", incoming, api, "No notes link here yet."),
              renderSection("LINKS FROM THIS NOTE", outgoing, api, "No linked notes found.")
            );
            return panel;
          }
        });
      }
    },
    {
      id: "tags",
      name: "Tags",
      description: "Browse inline #tags and filter the note list.",
      category: "Organization",
      defaultEnabled: true,
      activate(api) {
        api.ui.registerPanel({
          id: "tags",
          title: "Tag index",
          render() {
            const panel = document.createElement("section");
            panel.className = "plugin-panel-card tag-index";
            const heading = document.createElement("h3");
            heading.textContent = "TAG INDEX";
            panel.append(heading);
            const active = api.tags.active();
            if (active) {
              const clear = document.createElement("button");
              clear.type = "button";
              clear.className = "tag-chip is-active";
              clear.textContent = `${active} ×`;
              clear.setAttribute("aria-label", `Clear ${active} tag filter`);
              clear.addEventListener("click", () => api.tags.setFilter(null));
              panel.append(clear);
            }
            const tags = api.tags.list();
            if (tags.length === 0) {
              const empty = document.createElement("p");
              empty.className = "plugin-panel-empty";
              empty.textContent = "Add #tags to a note to start an index.";
              panel.append(empty);
              return panel;
            }
            const list = document.createElement("div");
            list.className = "tag-list";
            tags.forEach(({ tag, count }) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = `tag-chip${active === tag ? " is-active" : ""}`;
              button.textContent = `${tag} ${count}`;
              button.setAttribute("aria-pressed", String(active === tag));
              button.addEventListener("click", () => api.tags.setFilter(active === tag ? null : tag));
              list.append(button);
            });
            panel.append(list);
            return panel;
          }
        });
      }
    },
    {
      id: "outline",
      name: "Outline",
      description: "Jump to Markdown headings in the current note.",
      category: "Navigation",
      defaultEnabled: true,
      activate(api) {
        api.ui.registerPanel({
          id: "outline",
          title: "Outline",
          render({ note }) {
            const panel = document.createElement("section");
            panel.className = "plugin-panel-card outline-panel";
            const heading = document.createElement("h3");
            heading.textContent = "ON THIS PAGE";
            panel.append(heading);
            if (!note) {
              const empty = document.createElement("p");
              empty.className = "plugin-panel-empty";
              empty.textContent = "Select a note to see its headings.";
              panel.append(empty);
              return panel;
            }
            const headings = [];
            let offset = 0;
            note.body.split("\n").forEach((line) => {
              const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
              if (match) headings.push({ title: match[2], level: match[1].length, offset });
              offset += line.length + 1;
            });
            if (!headings.length) {
              const empty = document.createElement("p");
              empty.className = "plugin-panel-empty";
              empty.textContent = "Add Markdown headings to build an outline.";
              panel.append(empty);
              return panel;
            }
            const list = document.createElement("div");
            list.className = "outline-list";
            headings.forEach((item) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "outline-link";
              button.style.setProperty("--heading-depth", String(item.level - 1));
              button.textContent = item.title;
              button.addEventListener("click", () => api.editor.jumpTo(item.offset));
              list.append(button);
            });
            panel.append(list);
            return panel;
          }
        });
      }
    },
    {
      id: "word-count",
      name: "Word count",
      description: "Show a live count for the open note.",
      category: "Writing",
      defaultEnabled: true,
      activate(api) {
        api.ui.registerStatusItem({
          id: "word-count",
          render({ note }) {
            const status = document.createElement("span");
            status.className = "word-count-status";
            const count = note?.body.trim().match(/\S+/g)?.length ?? 0;
            status.textContent = `${count} ${count === 1 ? "word" : "words"}`;
            return status;
          }
        });
      }
    }
  ];

  window.PinboardPlugins = Object.freeze(plugins);
})();
