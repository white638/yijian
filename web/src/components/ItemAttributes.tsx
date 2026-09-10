import { attributeChoices, type ItemAttributeDraft } from "../item-attributes";
import { Field } from "./UI";
import "../item-attributes.css";

export function AttributeChoice({
  label,
  value,
  choices,
  onChange,
  maxLength = 80,
  hint,
}: {
  label: string;
  value: string;
  choices: string[];
  onChange: (value: string) => void;
  maxLength?: number;
  hint?: string;
}) {
  return (
    <div className="attribute-choice stack tight">
      <Field label={label} hint={hint}>
        <input
          value={value}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          placeholder="选择建议或自行填写"
        />
      </Field>
      <div className="attribute-chips" role="group" aria-label={`${label}建议`}>
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={value === choice}
            onClick={() => onChange(value === choice ? "" : choice)}
          >
            {choice}
          </button>
        ))}
      </div>
    </div>
  );
}
export function AttributeMultiChoice({
  label,
  value,
  choices,
  onChange,
  hint,
  limit,
}: {
  label: string;
  value: string[];
  choices: string[];
  onChange: (value: string[]) => void;
  hint?: string;
  limit: number;
}) {
  return (
    <div className="attribute-choice stack tight">
      <Field label={label} hint={hint}>
        <input
          value={value.join("、")}
          maxLength={limit * 81}
          onChange={(e) => onChange(e.target.value.split(/[、,，]/))}
          placeholder="可多选，用顿号分开自定义内容"
        />
      </Field>
      <div className="attribute-chips" role="group" aria-label={`${label}建议`}>
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={value.includes(choice)}
            disabled={value.length >= limit && !value.includes(choice)}
            onClick={() =>
              onChange(
                value.includes(choice)
                  ? value.filter((v) => v !== choice)
                  : [...value.filter(Boolean), choice],
              )
            }
          >
            {choice}
          </button>
        ))}
      </div>
    </div>
  );
}
export function ItemAttributeFields({
  value,
  onChange,
}: {
  value: ItemAttributeDraft;
  onChange: <K extends keyof ItemAttributeDraft>(
    field: K,
    value: ItemAttributeDraft[K],
  ) => void;
}) {
  return (
    <>
      <AttributeChoice
        label="图案"
        value={value.pattern}
        choices={attributeChoices.pattern}
        onChange={(v) => onChange("pattern", v)}
      />
      <AttributeMultiChoice
        label="材质"
        value={value.materials}
        choices={attributeChoices.materials}
        limit={10}
        hint="请按衣标确认材质及成分，照片外观不能确定纤维成分。"
        onChange={(v) => onChange("materials", v)}
      />
      <Field label="尺码" hint="按衣标或实际试穿填写。">
        <input
          value={value.size}
          maxLength={80}
          placeholder="例如：M / 170 / 38"
          onChange={(e) => onChange("size", e.target.value)}
        />
      </Field>
    </>
  );
}
