import { HTTPException } from "hono/http-exception";

export async function readFormData(
  request: { formData(): Promise<FormData> },
  message: string,
): Promise<FormData> {
  try {
    return await request.formData();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new HTTPException(422, { message });
  }
}
