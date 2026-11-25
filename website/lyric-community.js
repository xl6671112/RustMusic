(() => {
  const get = id => document.getElementById(`lyric-community-${id}`);
  const section = document.getElementById("lyric-community");
  if (!section) return;
  const login = get("login");
  const publish = get("publish");
  const feedback = get("feedback");
  const list = get("posts");
  const status = get("status");
  const more = get("more");
  let token = "";
  let cursor = 0;

  async function request(path, options) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (options?.headers?.Authorization && response.status === 401) switchAccount();
      throw new Error(data.error || `请求失败（${response.status}）`);
    }
    return data;
  }

  function switchAccount() {
    token = "";
    publish.hidden = true;
    login.hidden = false;
    get("user").textContent = "";
  }

  async function refresh(append = false) {
    more.disabled = true;
    status.textContent = "正在加载作品…";
    try {
      const data = await request(`/api/lyric-community${append ? `?before=${cursor}` : ""}`);
      if (!append) list.replaceChildren();
      for (const item of data.posts) {
        const card = document.createElement("article");
        card.className = "feature";
        const title = document.createElement("h3");
        title.textContent = item.title;
        const meta = document.createElement("small");
        meta.textContent = `${item.kind === "folia" ? "Folia 歌词包" : "HTML 歌词效果"} · ${item.author} · ${new Date(item.created).toLocaleDateString("zh-CN")}`;
        const description = document.createElement("p");
        description.textContent = item.description;
        const download = document.createElement("a");
        download.className = "button small";
        download.href = `/api/lyric-community/${encodeURIComponent(item.id)}`;
        download.download = "";
        download.textContent = "下载效果";
        card.append(title, meta, description, download);
        list.append(card);
      }
      cursor = data.next;
      more.hidden = !cursor;
      status.textContent = list.children.length ? "" : "还没有作品，欢迎发布第一个歌词效果。";
    } catch (error) {
      status.textContent = `作品加载失败。${error.message}`;
    } finally {
      more.disabled = false;
    }
  }

  login.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      const action = submit?.value === "register" ? "register" : "login";
      const data = await request(`/api/account/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(login))),
      });
      token = data.token;
      get("user").textContent = `当前账号 ${data.user.username}`;
      login.reset();
      login.hidden = true;
      publish.hidden = false;
      feedback.textContent = "";
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  const kind = publish.elements.namedItem("kind");
  const file = publish.elements.namedItem("effect");
  kind.addEventListener("change", () => {
    file.accept = kind.value === "html" ? ".html,.htm" : ".folia,.json";
    file.value = "";
  });
  publish.addEventListener("submit", async event => {
    event.preventDefault();
    if (!token || !file.files[0]) return;
    const html = kind.value === "html";
    if (file.files[0].size > (html ? 36_000 : 32 * 1024 * 1024) ||
        !(html ? /\.html?$/i : /\.(folia|json)$/i).test(file.files[0].name)) {
      feedback.textContent = "请选择符合类型和大小要求的效果文件。";
      return;
    }
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    feedback.textContent = "正在发布…";
    try {
      if (html) {
        const source = await file.files[0].text();
        const template = document.createElement("template");
        template.innerHTML = source;
        if (source.length > 12_000 || !template.content.querySelector('[data-rustmusic-slot="current"]') ||
            template.content.querySelector("iframe,object,embed,base,form")) {
          throw new Error("HTML 必须是播放器可用的歌词模板，并包含当前歌词标记。");
        }
      }
      await request("/api/lyric-community", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: new FormData(publish),
      });
      publish.reset();
      file.accept = ".folia,.json";
      feedback.textContent = "已发布。";
      await refresh();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  get("switch").addEventListener("click", switchAccount);
  more.addEventListener("click", () => void refresh(true));
  void refresh();
})();
