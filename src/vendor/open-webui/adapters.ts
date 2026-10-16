export const getOutputText = (_value: unknown) => "";
export const resolveLocalizedModelName = (model: { name?: string; id: string }, _language: string) => model.name ?? model.id;
