/* Template pack — example xPin plugin built against plugins/starter.
 * Inserts structured note templates at the caret via editor:write.
 */
xPinPlugin.register({
  activate(api) {
    const templates = [
      {
        id: "meeting",
        name: "Insert meeting notes",
        body: "## Meeting — {{date}}\n\n**Attendees:** \n\n## Agenda\n\n- \n\n## Notes\n\n\n## Decisions\n\n- \n\n## Next steps\n\n- [ ] ",
      },
      {
        id: "decision",
        name: "Insert decision log",
        body: "## Decision — {{date}}\n\n**Context:** \n\n**Options considered:**\n\n- \n\n**Chosen:** \n\n**Why:** \n",
      },
      {
        id: "reading",
        name: "Insert reading notes",
        body: "## Reading — {{title}}\n\n**Source:** \n\n## Key ideas\n\n- \n\n## Quotes\n\n> \n\n## My take\n\n",
      },
    ];
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    for (const template of templates) {
      api.commands.add({
        id: template.id,
        name: template.name,
        description: "Insert a structured template at the caret.",
        run: async () => {
          const current = await api.notes.current().catch(() => null);
          const title = current && typeof current.title === "string" ? current.title : "";
          await api.editor.insertText(template.body.replaceAll("{{date}}", date).replaceAll("{{title}}", title));
          await api.ui.notify(`${template.name.replace("Insert ", "")} template inserted.`);
        },
      });
    }
  },
});
