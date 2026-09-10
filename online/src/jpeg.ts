const invalid = () => new Error("图片不是有效的 JPEG 文件。");

/** Share copies omit metadata and trailing bytes, which can contain private location data. */
export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  if (input.length < 4 || input[0] !== 255 || input[1] !== 216) throw invalid();
  const parts: Uint8Array[] = [input.subarray(0, 2)];
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < input.length) {
    const start = offset;
    if (input[offset++] !== 255) throw invalid();
    while (input[offset] === 255) offset++;
    const marker = input[offset++];
    if (marker === 217) {
      if (!hasFrame || !hasScan) throw invalid();
      parts.push(new Uint8Array([255, 217]));
      const output = new Uint8Array(
        parts.reduce((sum, part) => sum + part.length, 0),
      );
      let cursor = 0;
      for (const part of parts) {
        output.set(part, cursor);
        cursor += part.length;
      }
      return output;
    }
    if (
      !marker ||
      marker === 216 ||
      (marker >= 208 && marker <= 215) ||
      offset + 2 > input.length
    )
      throw invalid();
    const length = input[offset] * 256 + input[offset + 1];
    const end = offset + length;
    if (length < 2 || end > input.length) throw invalid();
    if ([192, 193, 194].includes(marker)) {
      if (length < 8) throw invalid();
      const height = input[offset + 3] * 256 + input[offset + 4];
      const width = input[offset + 5] * 256 + input[offset + 6];
      if (!width || !height || width * height > 25_000_000) throw invalid();
      hasFrame = true;
    }
    if (!((marker >= 224 && marker <= 239 && marker !== 238) || marker === 254))
      parts.push(input.subarray(start, end));
    offset = end;
    if (marker === 218) {
      if (!hasFrame || length < 6) throw invalid();
      hasScan = true;
      const scanStart = offset;
      while (offset < input.length) {
        if (input[offset] !== 255) {
          offset++;
          continue;
        }
        const next = input[offset + 1];
        if (next === 0 || (next >= 208 && next <= 215)) {
          offset += 2;
          continue;
        }
        break;
      }
      parts.push(input.subarray(scanStart, offset));
    }
  }
  throw invalid();
}
