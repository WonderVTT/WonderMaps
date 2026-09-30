/**
 * A tiny HTML context menu positioned at a screen point, used for canvas objects.
 */
export class CanvasMenu {
  constructor() {
    this.element = null;
    this._onOutside = this._onOutside.bind(this);
    this._onKey = this._onKey.bind(this);
  }

  /**
   * @param {{x: number, y: number}} client   Screen position.
   * @param {string} title
   * @param {Array<{icon: string, label: string, callback: Function}>} items
   */
  open(client, title, items) {
    this.close();
    const menu = document.createElement("nav");
    menu.id = "wondermaps-menu";
    menu.classList.add("wondermaps-menu");

    const header = document.createElement("h4");
    header.textContent = title;
    menu.append(header);

    const list = document.createElement("ol");
    for ( const item of items ) {
      const li = document.createElement("li");
      li.innerHTML = `<i class="${item.icon}"></i> `;
      li.append(document.createTextNode(item.label));
      li.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        item.callback();
      });
      list.append(li);
    }
    menu.append(list);
    menu.addEventListener("contextmenu", event => event.preventDefault());
    document.body.append(menu);

    // Keep the menu inside the viewport.
    const rect = menu.getBoundingClientRect();
    const x = Math.min(client.x, window.innerWidth - rect.width - 8);
    const y = Math.min(client.y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    this.element = menu;

    // Defer so the click that opened the menu does not immediately close it.
    window.setTimeout(() => {
      if ( this.element !== menu ) return;
      window.addEventListener("pointerdown", this._onOutside, true);
      window.addEventListener("wheel", this._onOutside, true);
      window.addEventListener("keydown", this._onKey);
    }, 0);
  }

  close() {
    window.removeEventListener("pointerdown", this._onOutside, true);
    window.removeEventListener("wheel", this._onOutside, true);
    window.removeEventListener("keydown", this._onKey);
    this.element?.remove();
    this.element = null;
  }

  _onOutside(event) {
    if ( this.element?.contains(event.target) ) return;
    this.close();
  }

  _onKey(event) {
    if ( event.key === "Escape" ) this.close();
  }
}
