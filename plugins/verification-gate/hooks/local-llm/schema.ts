export type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  items?: JsonSchema
  enum?: readonly unknown[]
  minItems?: number
  maxItems?: number
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

/** Ollama の format に渡す JSON スキーマの部分集合で、応答を検証する。 */
export const matchesSchema = (value: unknown, schema: JsonSchema): boolean => {
  if (schema.enum !== undefined && !schema.enum.includes(value)) return false
  switch (schema.type) {
    case undefined:
      return true
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
      return typeof value === 'string' && (schema.minLength === undefined || value.length >= schema.minLength) && (schema.maxLength === undefined || value.length <= schema.maxLength)
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type === 'number' || Number.isInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum)
      )
    case 'array':
      return (
        Array.isArray(value) &&
        (schema.minItems === undefined || value.length >= schema.minItems) &&
        (schema.maxItems === undefined || value.length <= schema.maxItems) &&
        (schema.items === undefined || value.every(v => matchesSchema(v, schema.items!)))
      )
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const o = value as Record<string, unknown>
      return (
        (schema.required ?? []).every(k => k in o) &&
        Object.entries(schema.properties ?? {}).every(([k, s]) => !(k in o) || matchesSchema(o[k], s))
      )
    }
    default:
      return false
  }
}
