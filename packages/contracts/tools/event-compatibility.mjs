function variants(schema) {
  const branch = schema.allOf?.find(item => Array.isArray(item.oneOf) && item.oneOf.some(value => value.properties?.event_type?.const));
  return new Map((branch?.oneOf ?? []).map(value => [value.properties.event_type.const, value]));
}

function definition(schema, reference) {
  const prefix = '#/definitions/';
  if (typeof reference !== 'string' || !reference.startsWith(prefix)) return undefined;
  return schema.definitions?.[reference.slice(prefix.length)];
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function compareSchema(previous, current, path, errors) {
  if (!current || typeof current !== 'object') {
    errors.push(`${path}: removed or changed schema`);
    return;
  }
  if (stable(previous.required ?? []) !== stable(current.required ?? [])) {
    errors.push(`${path}: changed required fields`);
  }
  for (const [name, property] of Object.entries(previous.properties ?? {})) {
    compareSchema(property, current.properties?.[name], `${path}.${name}`, errors);
  }
  for (const name of Object.keys(current.properties ?? {})) {
    if (!(name in (previous.properties ?? {})) && (current.required ?? []).includes(name)) {
      errors.push(`${path}.${name}: added required field`);
    }
  }
  const previousEnum = previous.enum;
  const currentEnum = current.enum;
  if (previousEnum || currentEnum) {
    if (!previousEnum || !currentEnum || previousEnum.some(value => !currentEnum.some(candidate => stable(candidate) === stable(value)))) {
      errors.push(`${path}: narrowed or changed enum`);
    }
  }
  const ignored = new Set(['properties', 'required', 'enum']);
  const previousRules = Object.fromEntries(Object.entries(previous).filter(([key]) => !ignored.has(key)));
  const currentRules = Object.fromEntries(Object.entries(current).filter(([key]) => !ignored.has(key)));
  if (stable(previousRules) !== stable(currentRules)) errors.push(`${path}: changed constraints or type`);
}

export function eventCompatibilityErrors(previousSchema, currentSchema) {
  const errors = [];
  compareSchema({ ...previousSchema, allOf: undefined, definitions: undefined },
    { ...currentSchema, allOf: undefined, definitions: undefined }, 'envelope', errors);
  if (stable(previousSchema.allOf?.[0]) !== stable(currentSchema.allOf?.[0])) {
    errors.push('changed actor rules');
  }
  for (const [name, oldDefinition] of Object.entries(previousSchema.definitions ?? {})) {
    compareSchema(oldDefinition, currentSchema.definitions?.[name], `definitions.${name}`, errors);
  }
  const previousVariants = variants(previousSchema);
  const currentVariants = variants(currentSchema);
  for (const eventType of previousVariants.keys()) {
    if (!currentVariants.has(eventType)) errors.push(`${eventType}: removed event`);
  }
  for (const eventType of currentVariants.keys()) {
    if (!previousVariants.has(eventType)) errors.push(`${eventType}: added event within existing schema version`);
  }
  for (const [eventType, previousVariant] of previousVariants) {
    const currentVariant = currentVariants.get(eventType);
    if (!currentVariant) continue;
    compareSchema(previousVariant, currentVariant, `${eventType}.variant`, errors);
    for (const name of Object.keys(currentVariant.properties ?? {})) {
      if (!(name in (previousVariant.properties ?? {}))) errors.push(`${eventType}.variant.${name}: added envelope field`);
    }
    const previousPayload = definition(previousSchema, previousVariant.properties?.payload?.$ref);
    const currentPayload = definition(currentSchema, currentVariant.properties?.payload?.$ref);
    if (!previousPayload || !currentPayload) {
      errors.push(`${eventType}: payload schema cannot be resolved`);
      continue;
    }
    compareSchema(previousPayload, currentPayload, eventType, errors);
  }
  return errors;
}
