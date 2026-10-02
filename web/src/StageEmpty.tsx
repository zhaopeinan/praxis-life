import type { ReactNode } from "react";

/**
 * 舞台上统一的空状态 / 未配置状态。
 *
 * 视图（看板、日历、甘特、画册……）在「还没配好」或「还没有数据」时，
 * 都渲染这个组件，保证外观一致、并且始终给出下一步操作，而不是丢一句
 * 干巴巴的提示让用户自己猜。
 */
export function StageEmpty({
  icon,
  title,
  description,
  steps,
  actions,
  compact,
  tone = "warn",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** 可选的三步式引导，每项一句话 */
  steps?: ReactNode[];
  actions?: ReactNode;
  /** 更矮一些，用于视图内部（如画册里没有记录） */
  compact?: boolean;
  /** warn：还没配好；calm：配好了但还没数据 */
  tone?: "warn" | "calm";
}) {
  return (
    <div className={`stage-empty${compact ? " compact" : ""} tone-${tone}`}>
      <span className="stage-empty-icon" aria-hidden="true">
        {icon ?? "◌"}
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {steps && steps.length > 0 && (
        <ul className="stage-empty-steps">
          {steps.map((step, index) => (
            <li key={index}>
              <em>{index + 1}</em>
              <span>{step}</span>
            </li>
          ))}
        </ul>
      )}
      {actions && <div className="stage-empty-actions">{actions}</div>}
    </div>
  );
}
