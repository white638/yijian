import { attributeChoices, type ItemAttributeDraft } from "../item-attributes";
import { categories, itemName, type Item } from "../types";
import { AttributeChoice, AttributeMultiChoice } from "./ItemAttributes";
import { Button, Field, Garment, Sheet } from "./UI";
import "../item-extra-details.css";

export function ItemExtraDetails({
  item,
  value,
  onChange,
  onClose,
}: {
  item: Item;
  value: ItemAttributeDraft;
  onChange: <K extends keyof ItemAttributeDraft>(
    field: K,
    value: ItemAttributeDraft[K],
  ) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="详情" onClose={onClose}>
      <div className="item-extra-details">
        <div className="item-extra-preview">
          <Garment item={item} />
          <div>
            <h3>{itemName(item)}</h3>
            <p>{value.subcategory || categories[item.category]}</p>
          </div>
        </div>

        <div className="item-extra-fields">
          <AttributeMultiChoice
            label="风格"
            value={value.styles}
            choices={attributeChoices.styles}
            limit={12}
            onChange={(next) => onChange("styles", next)}
          />

          <div className="item-extra-grid">
            <AttributeChoice
              label="合身度"
              value={value.fit}
              choices={attributeChoices.fit}
              maxLength={40}
              onChange={(next) => onChange("fit", next)}
            />
            <AttributeChoice
              label="版型"
              value={value.cut}
              choices={attributeChoices.cut}
              onChange={(next) => onChange("cut", next)}
            />
            <AttributeChoice
              label="领型"
              value={value.neckline}
              choices={attributeChoices.neckline}
              onChange={(next) => onChange("neckline", next)}
            />
            <AttributeChoice
              label="袖长"
              value={value.sleeve_length}
              choices={attributeChoices.sleeve_length}
              maxLength={40}
              onChange={(next) => onChange("sleeve_length", next)}
            />
            <AttributeChoice
              label="长度"
              value={value.length}
              choices={attributeChoices.length}
              maxLength={40}
              onChange={(next) => onChange("length", next)}
            />
          </div>

          <Field label="洗护说明" hint="请按洗护标签或实际记录填写。">
            <textarea
              value={value.care_notes}
              rows={3}
              maxLength={1000}
              placeholder="例如：轻柔手洗，平铺晾干"
              onChange={(event) => onChange("care_notes", event.target.value)}
            />
          </Field>
        </div>

        <div className="item-extra-footer">
          <span>随单品资料一起保存</span>
          <Button type="button" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
