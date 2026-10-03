import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import { displayText } from "../../src/query-helpers.js";
import type {
  DocumentDetail,
  DocumentKind,
  DocumentRecordLink,
  DocumentRevision,
  DocumentSummary,
  Field,
  PublicRecord,
  TableSummary,
} from "../../src/types.js";
import { DOC_TEMPLATES } from "../../src/types.js";
import { api } from "./api";
import { MarkdownView } from "./markdown";
import { DropMenu, FancySelect } from "./ui";

type EditorMode = "split" | "edit" | "preview";

const LINK_LABEL_PRESETS = ["实验前思考", "实验复盘", "相关记录"];

function fmtTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function childrenOf(documents: DocumentSummary[]): Map<string, DocumentSummary[]> {
  const map = new Map<string, DocumentSummary[]>();
  for (const doc of documents) {
    const key = doc.parentId ?? "";
    const list = map.get(key) ?? [];
    list.push(doc);
    map.set(key, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind === "folder" ? -1 : 1));
  }
  return map;
}

/* ——— 文档树（侧边栏与文档页共用） ——— */

export function DocumentTree({
  baseId,
  documents,
  selectedId,
  onSelect,
  canEdit,
  onChanged,
  onError,
  onNotice,
}: {
  baseId: string;
  documents: DocumentSummary[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  canEdit: boolean;
  onChanged: () => void | Promise<void>;
  onError: (err: unknown) => void;
  onNotice?: (text: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const byParent = useMemo(() => childrenOf(documents), [documents]);

  async function newChild(parentId: string | null, kind: DocumentKind, template?: string) {
    try {
      const created = await api.createDocument(baseId, {
        parentId,
        kind,
        template: template ?? null,
        title: kind === "folder" ? "新建文件夹" : undefined,
      });
      await onChanged();
      onSelect(created.id);
      onNotice?.(kind === "folder" ? "已新建文件夹" : "已新建文档");
    } catch (err) {
      onError(err);
    }
  }

  async function remove(node: DocumentSummary) {
    const tip =
      node.kind === "folder" && node.childCount > 0
        ? `删除文件夹「${node.title}」？其中 ${node.childCount} 个文档会一起删除。`
        : `删除文档「${node.title}」？`;
    if (!window.confirm(tip)) return;
    try {
      await api.deleteDocument(node.id);
      // 删掉的正好是当前打开的那篇，就退回文档首页，免得停在一个已经不存在的 id 上。
      if (node.id === selectedId) onSelect(null);
      await onChanged();
    } catch (err) {
      onError(err);
    }
  }

  function renderNodes(parentId: string | null, depth: number) {
    const list = byParent.get(parentId ?? "") ?? [];
    if (!list.length) return null;
    return (
      <ul className="doc-tree" style={{ paddingLeft: depth === 0 ? 0 : 12 }} key={parentId ?? "__root"}>
        {list.map((node) => {
          const isOpen = !collapsed.has(node.id);
          const hasChildren = node.childCount > 0;
          return (
            <li key={node.id} className="doc-tree-item">
              <div className={node.id === selectedId ? "doc-row on" : "doc-row"}>
                {hasChildren ? (
                  <button
                    type="button"
                    className="doc-caret"
                    aria-label={isOpen ? "折叠" : "展开"}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(node.id)) next.delete(node.id);
                        else next.add(node.id);
                        return next;
                      })
                    }
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="doc-caret ghost" aria-hidden>
                    ·
                  </span>
                )}
                <button type="button" className="doc-link" onClick={() => onSelect(node.id)} title={node.title}>
                  <span className="doc-icon" aria-hidden>
                    {node.icon || (node.kind === "folder" ? "📁" : "📄")}
                  </span>
                  <span className="doc-label">{node.title}</span>
                  {node.linkCount > 0 && <span className="doc-badge" title="关联的实验记录数">{node.linkCount}</span>}
                </button>
                {canEdit && (
                  <DropMenu label="⋯" ariaLabel={`${node.title} 操作`} className="doc-menu">
                    {node.kind === "folder" && (
                      <>
                        <button type="button" onClick={() => void newChild(node.id, "doc")}>
                          在文件夹内新建文档
                        </button>
                        <button type="button" onClick={() => void newChild(node.id, "folder")}>
                          新建子文件夹
                        </button>
                        <hr className="menu-sep" />
                      </>
                    )}
                    <button type="button" className="danger-text" onClick={() => void remove(node)}>
                      删除
                    </button>
                  </DropMenu>
                )}
              </div>
              {hasChildren && isOpen && renderNodes(node.id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  }

  if (!documents.length) {
    return (
      <div className="doc-tree-empty">
        <p>还没有文档。</p>
        {canEdit && (
          <button type="button" className="secondary tiny-btn" onClick={() => void newChild(null, "doc", "experiment-plan")}>
            用「实验前思考」模板新建
          </button>
        )}
      </div>
    );
  }

  return <div className="doc-tree-wrap">{renderNodes(null, 0)}</div>;
}

/* ——— 关联记录选择器 ——— */

function recordLabel(record: PublicRecord, fields: Field[]): string {
  const field =
    fields.find((item) => item.name === "标题") ??
    fields.find((item) => item.type === "text") ??
    fields.find((item) => item.type === "long_text");
  const value = field ? record.fields[field.name] : null;
  return displayText(value) || record.id.slice(0, 8);
}

function RecordPicker({
  tables,
  onPick,
  onCancel,
  onError,
}: {
  tables: TableSummary[];
  onPick: (recordId: string, tableId: string, label: string) => void;
  onCancel: () => void;
  onError: (err: unknown) => void;
}) {
  const [tableId, setTableId] = useState(tables[0]?.id ?? "");
  const [fields, setFields] = useState<Field[]>([]);
  const [records, setRecords] = useState<PublicRecord[]>([]);
  const [keyword, setKeyword] = useState("");
  const [label, setLabel] = useState(LINK_LABEL_PRESETS[0]);
  const [busy, setBusy] = useState(false);
  // 用 ref 存回调：父组件的 onError 每次渲染都是新函数，直接进依赖会导致无限重拉。
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!tableId) return;
    setBusy(true);
    api
      .getTable(tableId)
      .then((payload) => {
        setFields(payload.fields);
        setRecords(payload.records);
      })
      .catch((err) => onErrorRef.current(err))
      .finally(() => setBusy(false));
  }, [tableId]);

  const shown = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const list = q
      ? records.filter((record) => recordLabel(record, fields).toLowerCase().includes(q))
      : records;
    return list.slice(0, 40);
  }, [records, fields, keyword]);

  return (
    <div className="doc-panel">
      <div className="doc-panel-head">
        <strong>关联实验记录</strong>
        <button type="button" className="ghost" onClick={onCancel}>
          取消
        </button>
      </div>
      <label className="doc-field">
        <span>清单</span>
        <FancySelect
          value={tableId}
          options={tables.map((table) => ({ value: table.id, label: table.name }))}
          onChange={setTableId}
          aria-label="选择清单"
        />
      </label>
      <label className="doc-field">
        <span>标签</span>
        <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：实验复盘" />
      </label>
      <input
        className="doc-search"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder="搜索记录标题"
      />
      {busy && <p className="doc-hint">加载中…</p>}
      {!busy && !shown.length && <p className="doc-hint">这张清单里还没有记录。</p>}
      <ul className="doc-record-list">
        {shown.map((record) => (
          <li key={record.id}>
            <button type="button" onClick={() => onPick(record.id, tableId, label.trim())}>
              {recordLabel(record, fields)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ——— 文档主视图 ——— */

export function DocumentsView({
  baseId,
  tables,
  canEdit,
  documents,
  selectedId,
  onSelect,
  onReload,
  onError,
  onNotice,
  onOpenRecord,
}: {
  baseId: string;
  tables: TableSummary[];
  canEdit: boolean;
  documents: DocumentSummary[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onReload: () => void | Promise<void>;
  onError: (err: unknown) => void;
  onNotice: (text: string) => void;
  onOpenRecord?: (recordId: string, tableId: string) => void;
}) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<EditorMode>("split");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);
  const latest = useRef({ title: "", body: "" });
  const baseTitle = useRef("");
  const openIdRef = useRef<string | null>(null);
  const saveIdRef = useRef<string | null>(null);
  // 父组件的 onError 每次渲染都是新函数；放进依赖会反复重拉文档并清空正在写的内容。
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const onReloadRef = useRef(onReload);
  useEffect(() => {
    onReloadRef.current = onReload;
  }, [onReload]);

  const isFolder = detail?.kind === "folder";

  useEffect(() => {
    // openIdRef 记「编辑器此刻在展示哪一篇」；saveIdRef 记「latest.current 里的内容属于哪一篇」。
    // 保存是异步的，两者可能短暂不一致，用它来判断回来的结果还要不要写进界面。
    openIdRef.current = selectedId;
    // 切换文档前先把还没落盘的改动存掉，否则新文档的正文会覆盖到旧文档上。
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
      void save();
    }
    if (!selectedId) {
      saveIdRef.current = null;
      setDetail(null);
      setRevisions([]);
      return;
    }
    let cancel = false;
    setLoading(true);
    api
      .getDocument(selectedId)
      .then((data) => {
        if (cancel) return;
        saveIdRef.current = data.id;
        setDetail(data);
        setTitle(data.title);
        setBody(data.bodyMd);
        baseTitle.current = data.title;
        latest.current = { title: data.title, body: data.bodyMd };
        setDirty(false);
        setSavedAt(null);
        setShowHistory(false);
        setShowLink(false);
      })
      .catch((err) => {
        if (!cancel) onErrorRef.current(err);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [selectedId]);

  const save = useCallback(
    async (next?: { title?: string; body?: string }) => {
      const documentId = saveIdRef.current;
      if (!documentId || !canEdit) return;
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const payload = {
        title: next?.title ?? latest.current.title,
        bodyMd: next?.body ?? latest.current.body,
      };
      setSaving(true);
      try {
        const result = await api.updateDocument(documentId, payload);
        if (result.id === openIdRef.current) {
          setDetail(result);
          latest.current = { title: result.title, body: result.bodyMd };
          setTitle(result.title);
          setDirty(false);
          setSavedAt(Date.now());
          if (result.title !== baseTitle.current) {
            baseTitle.current = result.title;
            await onReloadRef.current();
          }
        } else {
          // 保存期间已经切走了：只刷新列表标题，别把旧文档的内容写回编辑器。
          await onReloadRef.current();
        }
      } catch (err) {
        onErrorRef.current(err);
      } finally {
        setSaving(false);
      }
    },
    [canEdit],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  useEffect(
    () => () => {
      // 离开文档页时把待存的改动补一次，避免最后 1.2 秒的输入丢掉。
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        void save();
      }
    },
    [],
  );

  function scheduleSave(next: { title?: string; body?: string }) {
    if (next.title !== undefined) latest.current.title = next.title;
    if (next.body !== undefined) latest.current.body = next.body;
    setDirty(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void save(), 1200);
  }

  async function createDoc(input: { title?: string; kind?: DocumentKind; template?: string | null; parentId?: string | null }) {
    try {
      const created = await api.createDocument(baseId, input);
      await onReload();
      onSelect(created.id);
    } catch (err) {
      onError(err);
    }
  }

  async function renameTitle(next: string) {
    setTitle(next);
    scheduleSave({ title: next });
  }

  function insertAtCursor(snippet: string) {
    const area = areaRef.current;
    if (!area) {
      const next = `${latest.current.body}\n${snippet}`;
      setBody(next);
      scheduleSave({ body: next });
      return;
    }
    const start = area.selectionStart ?? latest.current.body.length;
    const end = area.selectionEnd ?? start;
    const current = latest.current.body;
    const next = `${current.slice(0, start)}${snippet}${current.slice(end)}`;
    setBody(next);
    scheduleSave({ body: next });
    requestAnimationFrame(() => {
      area.focus();
      const caret = start + snippet.length;
      area.setSelectionRange(caret, caret);
    });
  }

  async function uploadImage(file: File): Promise<{ name: string; url: string } | null> {
    try {
      const buffer = await file.arrayBuffer();
      const binary = Array.from(new Uint8Array(buffer), (byte) => String.fromCharCode(byte)).join("");
      const uploaded = await api.upload(file.name || "image.png", btoa(binary), file.type || undefined, {
        baseId,
        minRole: "viewer",
      });
      return { name: uploaded.name, url: uploaded.url };
    } catch (err) {
      onError(err);
      return null;
    }
  }

  async function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canEdit) return;
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) {
      const uploaded = await uploadImage(file);
      if (uploaded) insertAtCursor(`![${uploaded.name}](${uploaded.url})\n`);
    }
  }

  async function pickImage() {
    fileRef.current?.click();
  }

  async function onFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const uploaded = await uploadImage(file);
      if (uploaded) insertAtCursor(`![${uploaded.name}](${uploaded.url})\n`);
    }
  }

  async function openHistory() {
    if (!detail) return;
    setShowLink(false);
    setShowHistory(true);
    try {
      setRevisions(await api.documentRevisions(detail.id));
    } catch (err) {
      onError(err);
    }
  }

  async function restore(revisionId: string) {
    if (!detail) return;
    if (!window.confirm("恢复到这个版本？当前内容会先存进历史。")) return;
    try {
      const result = await api.restoreDocumentRevision(detail.id, revisionId);
      setDetail(result);
      setTitle(result.title);
      setBody(result.bodyMd);
      latest.current = { title: result.title, body: result.bodyMd };
      baseTitle.current = result.title;
      setDirty(false);
      setSavedAt(Date.now());
      setRevisions(await api.documentRevisions(detail.id));
      await onReload();
      onNotice("已恢复到所选版本");
    } catch (err) {
      onError(err);
    }
  }

  async function linkRecord(recordId: string, _tableId: string, label: string) {
    if (!detail) return;
    try {
      const result = await api.linkDocumentRecord(detail.id, recordId, label || null);
      setDetail(result);
      setShowLink(false);
      await onReload();
      onNotice("已关联记录");
    } catch (err) {
      onError(err);
    }
  }

  async function unlink(recordId: string) {
    if (!detail) return;
    try {
      setDetail(await api.unlinkDocumentRecord(detail.id, recordId));
      await onReload();
    } catch (err) {
      onError(err);
    }
  }

  async function moveToFolder(parentId: string) {
    if (!detail) return;
    try {
      const result = await api.moveDocument(detail.id, parentId || null);
      setDetail(result);
      await onReload();
      onNotice("已移动");
    } catch (err) {
      onError(err);
    }
  }

  const folderOptions = useMemo(
    () => [
      { value: "", label: "（空间根目录）" },
      ...documents
        .filter((doc) => doc.kind === "folder" && doc.id !== detail?.id)
        .map((doc) => ({ value: doc.id, label: doc.title })),
    ],
    [documents, detail],
  );

  const recent = useMemo(
    () => [...documents].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6),
    [documents],
  );

  const homeView = (
    <div className="docs-home">
      <h2>文档：写下思考，也写下复盘</h2>
      <p>
        这里的文档是 Markdown 长文，支持表格、代码块、数学公式（KaTeX）和 Mermaid 图。适合放实验前的假设与设计，
        以及实验后的结论与复盘——再把它们挂到对应的实验记录上。
      </p>
      {canEdit && (
        <div className="docs-empty-actions">
          {DOC_TEMPLATES.map((template) => (
            <button key={template.id} type="button" className="primary" onClick={() => void createDoc({ template: template.id })}>
              ＋ {template.name}
            </button>
          ))}
          <button type="button" className="secondary" onClick={() => void createDoc({})}>
            ＋ 空白文档
          </button>
          <button type="button" className="secondary" onClick={() => void createDoc({ kind: "folder" })}>
            ＋ 文件夹
          </button>
        </div>
      )}
      {recent.length > 0 && (
        <div className="docs-recent">
          <h3>最近更新</h3>
          <ul>
            {recent.map((doc) => (
              <li key={doc.id}>
                <button type="button" onClick={() => onSelect(doc.id)}>
                  <span>{doc.icon || (doc.kind === "folder" ? "📁" : "📄")}</span> {doc.title}
                  <em>{fmtTime(doc.updatedAt)}</em>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  const statusText = saving ? "保存中…" : dirty ? "有未保存修改" : savedAt ? `已保存 ${fmtTime(savedAt)}` : "已同步";

  return (
    <div className="docs-layout">
      <aside className="docs-side">
        <div className="docs-side-head">
          <strong>文档</strong>
          {canEdit && (
            <DropMenu label="＋" ariaLabel="新建文档" className="doc-new">
              <button type="button" onClick={() => void createDoc({})}>
                空白文档
              </button>
              {DOC_TEMPLATES.map((template) => (
                <button key={template.id} type="button" onClick={() => void createDoc({ template: template.id })}>
                  {template.name}
                </button>
              ))}
              <hr className="menu-sep" />
              <button type="button" onClick={() => void createDoc({ kind: "folder" })}>
                新建文件夹
              </button>
            </DropMenu>
          )}
        </div>
        <div className="docs-side-scroll">
          <DocumentTree
            baseId={baseId}
            documents={documents}
            selectedId={selectedId}
            onSelect={(id) => onSelect(id)}
            canEdit={canEdit}
            onChanged={onReload}
            onError={onError}
            onNotice={onNotice}
          />
        </div>
      </aside>

      <section className="docs-main">
        {!selectedId && homeView}
        {selectedId && loading && !detail && <p className="stage-note">加载中…</p>}
        {selectedId && detail && (
          <>
            <header className="docs-head">
              <input
                className="docs-title"
                value={title}
                disabled={!canEdit}
                placeholder="未命名文档"
                onChange={(event) => void renameTitle(event.target.value)}
                onBlur={() => dirty && void save()}
              />
              <span className={dirty ? "docs-status dirty" : "docs-status"}>{statusText}</span>
              {!isFolder && (
                <div className="docs-mode" role="tablist" aria-label="编辑模式">
                  {(["edit", "split", "preview"] as EditorMode[]).map((item) => (
                    <button
                      key={item}
                      type="button"
                      role="tab"
                      aria-selected={mode === item}
                      className={mode === item ? "on" : ""}
                      onClick={() => setMode(item)}
                    >
                      {item === "edit" ? "编辑" : item === "split" ? "分栏" : "预览"}
                    </button>
                  ))}
                </div>
              )}
              {canEdit && (
                <div className="docs-actions">
                  {!isFolder && (
                    <>
                      <button type="button" className="secondary" onClick={() => void pickImage()}>
                        插入图片
                      </button>
                      <button type="button" className="secondary" onClick={() => void save()}>
                        保存
                      </button>
                    </>
                  )}
                  <button type="button" className="secondary" onClick={() => void openHistory()}>
                    历史
                  </button>
                  {!isFolder && (
                    <DropMenu label="⋯" ariaLabel="文档操作" className="doc-actions-menu">
                      <button
                        type="button"
                        onClick={() => {
                          setShowHistory(false);
                          setShowLink(true);
                        }}
                      >
                        关联实验记录…
                      </button>
                      {folderOptions.length > 1 && (
                        <>
                          <hr className="menu-sep" />
                          {folderOptions.map((option) => (
                            <button
                              key={option.value || "__root"}
                              type="button"
                              disabled={option.value === (detail.parentId ?? "")}
                              onClick={() => void moveToFolder(option.value)}
                            >
                              移动到 {option.label}
                            </button>
                          ))}
                        </>
                      )}
                    </DropMenu>
                  )}
                </div>
              )}
            </header>

            {isFolder ? (
              <div className="docs-folder">
                <p>这是一个文件夹，用来给文档分组。</p>
                {canEdit && (
                  <div className="docs-empty-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void createDoc({ parentId: detail.id, template: "experiment-plan" })}
                    >
                      ＋ 在里面建一篇实验前思考
                    </button>
                    <button type="button" className="secondary" onClick={() => void createDoc({ parentId: detail.id })}>
                      ＋ 空白文档
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className={`docs-body mode-${mode}`}>
                {mode !== "preview" && (
                  <textarea
                    ref={areaRef}
                    className="docs-editor"
                    value={body}
                    readOnly={!canEdit}
                    spellCheck={false}
                    placeholder="用 Markdown 写…支持 # 标题、- 列表、``` 代码块、$公式$、```mermaid 图"
                    onChange={(event) => {
                      setBody(event.target.value);
                      scheduleSave({ body: event.target.value });
                    }}
                    onPaste={(event) => void onPaste(event)}
                    onKeyDown={(event) => {
                      if (event.key === "Tab") {
                        event.preventDefault();
                        insertAtCursor("  ");
                      }
                    }}
                  />
                )}
                {mode !== "edit" && <MarkdownView source={body} />}
              </div>
            )}

            {showHistory && (
              <div className="doc-panel doc-history">
                <div className="doc-panel-head">
                  <strong>历史版本</strong>
                  <button type="button" className="ghost" onClick={() => setShowHistory(false)}>
                    关闭
                  </button>
                </div>
                {!revisions.length && <p className="doc-hint">还没有历史版本。每次改动都会自动留一版。</p>}
                <ul>
                  {revisions.map((revision) => (
                    <li key={revision.id}>
                      <span>
                        {fmtTime(revision.createdAt)} · {revision.userName || "未知"}
                      </span>
                      <button type="button" className="secondary tiny-btn" onClick={() => void restore(revision.id)}>
                        {canEdit ? "恢复" : "查看"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {showLink && (
              <RecordPicker tables={tables} onPick={linkRecord} onCancel={() => setShowLink(false)} onError={onError} />
            )}

            {detail.links.length > 0 && (
              <div className="doc-links">
                <h3>关联的实验记录</h3>
                <ul>
                  {detail.links.map((link: DocumentRecordLink) => (
                    <li key={link.recordId}>
                      {link.label && <span className="doc-link-tag">{link.label}</span>}
                      <button
                        type="button"
                        className="doc-record-link"
                        onClick={() => onOpenRecord?.(link.recordId, link.tableId)}
                        disabled={!onOpenRecord}
                      >
                        {link.tableName} · {link.recordTitle}
                      </button>
                      {canEdit && (
                        <button type="button" className="ghost danger-text" onClick={() => void unlink(link.recordId)}>
                          解除
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => void onFilePicked(event)} />
      </section>
    </div>
  );
}
