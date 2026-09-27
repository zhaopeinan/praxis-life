import { useEffect, useState } from "react";
import type { DisplayValue, Field, PublicRecord } from "../../src/types.js";
import { api } from "./api";
import { FormView } from "./ExtraViews";
import { displayText } from "../../src/query-helpers.js";

type PublicPayload = {
  kind: "view" | "form";
  viewId: string | null;
  table: {
    id: string;
    name: string;
    fields: Field[];
    records: PublicRecord[];
  };
};

export function PublicShareScreen({ token }: { token: string }) {
  const [data, setData] = useState<PublicPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .getPublicShare(token)
      .then((payload) => setData(payload as PublicPayload))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="boot">正在打开分享…</div>;
  if (error) {
    return (
      <div className="public-share">
        <h1>无法打开分享</h1>
        <p className="form-error">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="public-share">
      <header>
        <p className="eyebrow">知行人生 · 公开分享</p>
        <h1>{data.table.name}</h1>
        <p className="fine">{data.kind === "form" ? "填写并提交表单" : "只读视图"}</p>
      </header>
      {data.kind === "form" ? (
        <FormView
          fields={data.table.fields}
          readOnly={false}
          onSubmit={async (values) => {
            await api.submitPublicForm(token, values);
          }}
        />
      ) : (
        <PublicGrid fields={data.table.fields} records={data.table.records} />
      )}
    </div>
  );
}

function PublicGrid({ fields, records }: { fields: Field[]; records: PublicRecord[] }) {
  const visible = fields.filter((field) => field.type !== "button");
  return (
    <div className="public-grid-wrap">
      <table className="public-grid">
        <thead>
          <tr>
            {visible.map((field) => (
              <th key={field.id}>{field.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.length === 0 && (
            <tr>
              <td colSpan={Math.max(visible.length, 1)} className="fine">
                暂无数据
              </td>
            </tr>
          )}
          {records.map((record) => (
            <tr key={record.id}>
              {visible.map((field) => (
                <td key={field.id}>{formatCell(record.fields[field.name])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: DisplayValue | undefined): string {
  if (value == null) return "—";
  if (typeof value === "string" && value.startsWith("data:image/")) return "（签字）";
  return displayText(value) || "—";
}
