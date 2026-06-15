/**
 * generate-python.ts
 *
 * Codegen script: reads every Zod schema from the gateway-contracts package
 * and emits equivalent Pydantic BaseModel classes in Python.
 *
 * Usage: npx tsx scripts/generate-python.ts
 *
 * Output: packages/gateway-contracts/generated/python/*.py
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const OUTPUT_DIR = path.resolve(__dirname, '..', 'generated', 'python');

// ── Schema registry ────────────────────────────────────────────────────
// Each module exports schemas that should be codegen'd.
// Manually list them here so the script knows what to traverse.

interface SchemaEntry {
  name: string;
  schema: z.ZodType<any>;
}

type SchemaModule = Record<string, z.ZodType<any>>;

// Helper to collect all Zod object schemas from a module
function collectSchemas(mod: Record<string, unknown>): SchemaEntry[] {
  const entries: SchemaEntry[] = [];
  for (const [key, val] of Object.entries(mod)) {
    if (val instanceof z.ZodObject || val instanceof z.ZodEffects) {
      entries.push({ name: key, schema: val as z.ZodType<any> });
    }
  }
  return entries;
}

// ── Type mapping ───────────────────────────────────────────────────────

function zodTypeToPython(typeDef: z.ZodTypeAny, indent = 0): string {
  const ind = '  '.repeat(indent);

  if (typeDef instanceof z.ZodString) {
    return 'str';
  }

  if (typeDef instanceof z.ZodNumber) {
    const isInt = typeDef._def?.checks?.some((c: any) => c.kind === 'int');
    return isInt ? 'int' : 'float';
  }

  if (typeDef instanceof z.ZodBoolean) {
    return 'bool';
  }

  if (typeDef instanceof z.ZodNull || typeDef instanceof z.ZodNever) {
    return 'None';
  }

  if (typeDef instanceof z.ZodAny || typeDef instanceof z.ZodUnknown) {
    return 'Any';
  }

  if (typeDef instanceof z.ZodLiteral) {
    const val = typeDef._def.value;
    if (typeof val === 'string') return `'${val}'`;
    return String(val);
  }

  if (typeDef instanceof z.ZodEnum) {
    const values = typeDef._def.values as string[];
    return `Literal[${values.map(v => `'${v}'`).join(', ')}]`;
  }

  if (typeDef instanceof z.ZodNativeEnum) {
    const values = Object.values(typeDef._def.values);
    const strVals = values.filter(v => typeof v === 'string');
    if (strVals.length > 0) {
      return `Literal[${strVals.map(v => `'${v}'`).join(', ')}]`;
    }
    return 'str';
  }

  if (typeDef instanceof z.ZodArray) {
    const inner = zodTypeToPython(typeDef._def.type, indent);
    return `list[${inner}]`;
  }

  if (typeDef instanceof z.ZodRecord) {
    const valType = typeDef._def.valueType;
    if (valType instanceof z.ZodUnknown || valType instanceof z.ZodAny) {
      return 'dict[str, Any]';
    }
    const inner = zodTypeToPython(valType, indent);
    return `dict[str, ${inner}]`;
  }

  if (typeDef instanceof z.ZodObject) {
    // Nested object -> emit inline TypedDict reference
    const shape = typeDef._def.shape();
    const fields: string[] = [];
    for (const [key, fieldDef] of Object.entries(shape)) {
      const fieldType = zodTypeToPython(fieldDef as z.ZodTypeAny, indent + 1);
      fields.push(`${ind}  ${key}: ${fieldType}`);
    }
    if (fields.length === 0) return 'dict[str, Any]';
    return `dict[str, Any]  # inline: { ${fields.join(', ')} }`;
  }

  if (typeDef instanceof z.ZodUnion || typeDef instanceof z.ZodDiscriminatedUnion) {
    const options = typeDef instanceof z.ZodDiscriminatedUnion
      ? Object.values(typeDef._def.optionsMap || {})
      : typeDef._def.options;
    const types = options.map((opt: z.ZodTypeAny) => zodTypeToPython(opt, indent));
    return `Union[${types.join(', ')}]`;
  }

  if (typeDef instanceof z.ZodOptional) {
    const inner = zodTypeToPython(typeDef._def.innerType, indent);
    return `Optional[${inner}]`;
  }

  if (typeDef instanceof z.ZodNullable) {
    const inner = zodTypeToPython(typeDef._def.innerType, indent);
    return `Optional[${inner}]`;
  }

  if (typeDef instanceof z.ZodDefault) {
    return zodTypeToPython(typeDef._def.innerType, indent);
  }

  if (typeDef instanceof z.ZodEffects) {
    return zodTypeToPython(typeDef._def.schema, indent);
  }

  if (typeDef instanceof z.ZodLazy) {
    return 'Any';
  }

  if (typeDef instanceof z.ZodPipeline) {
    return zodTypeToPython(typeDef._def.out, indent);
  }

  return 'Any';
}

function getDefaultValue(typeDef: z.ZodTypeAny): string | null {
  // Check for default
  if (typeDef instanceof z.ZodDefault) {
    const def = typeDef._def.defaultValue();
    if (typeof def === 'string') return `'${def.replace(/'/g, "\\'")}'`;
    if (typeof def === 'number') return String(def);
    if (typeof def === 'boolean') return String(def);
    if (def === null) return 'None';
    if (Array.isArray(def)) return 'None'; // can't inline list defaults
    if (typeof def === 'object') return 'None';
    return 'None';
  }

  // Handle optional -> default None
  if (typeDef instanceof z.ZodOptional) {
    return 'None';
  }

  if (typeDef instanceof z.ZodNullable) {
    return 'None';
  }

  return null;
}

function getPythonTypeWithDefault(typeDef: z.ZodTypeAny, indent = 0): { pyType: string; defaultVal: string | null } {
  const effective = typeDef instanceof z.ZodDefault
    ? typeDef._def.innerType
    : typeDef;

  const pyType = zodTypeToPython(effective, indent);
  const defaultVal = getDefaultValue(typeDef);

  return { pyType, defaultVal };
}

// ── Python model generation ────────────────────────────────────────────

interface GeneratedField {
  name: string;
  pyType: string;
  defaultVal: string | null;
}

function generatePydanticModel(
  className: string,
  schema: z.ZodObject<any> | z.ZodEffects<any>,
): string {
  // Unwrap effects
  let obj: z.ZodObject<any>;
  if (schema instanceof z.ZodEffects) {
    const inner = schema._def.schema;
    if (inner instanceof z.ZodObject) {
      obj = inner;
    } else {
      return `# ${className}: skipped (non-object ZodEffects)\n`;
    }
  } else {
    obj = schema;
  }

  const shape = obj._def.shape();
  const fields: GeneratedField[] = [];
  const imports = new Set<string>();
  imports.add('from pydantic import BaseModel');
  imports.add('from typing import Any');

  for (const [key, fieldDef] of Object.entries(shape)) {
    const { pyType, defaultVal } = getPythonTypeWithDefault(fieldDef as z.ZodTypeAny, 1);

    // Track needed imports
    if (pyType.startsWith('Optional[')) imports.add('from typing import Optional');
    if (pyType.startsWith('Union[')) imports.add('from typing import Union');
    if (pyType.startsWith('Literal[')) imports.add('from typing import Literal');
    if (pyType.startsWith('list[')) imports.add('from typing import List');

    fields.push({ name: key, pyType, defaultVal });
  }

  const lines: string[] = [];

  // Sort imports
  const sortedImports = Array.from(imports).sort();
  lines.push(...sortedImports, '');

  // BaseModel class
  lines.push('');
  lines.push('');
  lines.push(`class ${className}(BaseModel):`);

  if (fields.length === 0) {
    lines.push('    pass');
  } else {
    for (const field of fields) {
      const typ = field.pyType;
      if (field.defaultVal !== null) {
        lines.push(`    ${field.name}: ${typ} = ${field.defaultVal}`);
      } else {
        lines.push(`    ${field.name}: ${typ}`);
      }
    }
  }

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log('Generating Python Pydantic models from Zod schemas...');

  // Ensure output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Import all schema modules
  const schemaModules: Record<string, SchemaModule> = {
    types: await import('../src/types'),
    memory: await import('../src/memory'),
    interpreter: await import('../src/interpreter'),
    'graph-builder': await import('../src/graph-builder'),
    'logic-engine': await import('../src/logic-engine'),
    observer: await import('../src/observer'),
    teaching: await import('../src/teaching'),
    'response-generator': await import('../src/response-generator'),
    'dev-agent': await import('../src/dev-agent'),
    artifact: await import('../src/artifact'),
  };

  // Generate __init__.py with exports
  const initLines: string[] = [
    '# Auto-generated by generate-python.ts',
    '# Do not edit manually — changes go in Zod schemas, regenerate via `npm run generate-python`',
    '',
  ];

  for (const [moduleName, schemas] of Object.entries(schemaModules)) {
    const entries = collectSchemas(schemas as Record<string, unknown>);
    if (entries.length === 0) continue;

    const outputFile = path.join(OUTPUT_DIR, `${moduleName.replace(/-/g, '_')}.py`);
    const fileLines: string[] = [
      `# Auto-generated by generate-python.ts`,
      `# Source: packages/gateway-contracts/src/${moduleName}.ts`,
      `# Do not edit manually — changes go in Zod schemas, regenerate via \`npm run generate-python\``,
      '',
    ];

    for (const entry of entries) {
      try {
        const modelCode = generatePydanticModel(entry.name, entry.schema);
        fileLines.push(modelCode);
      } catch (err) {
        console.warn(`  [SKIP] ${entry.name}: ${err}`);
      }
    }

    fs.writeFileSync(outputFile, fileLines.join('\n'), 'utf-8');
    console.log(`  Wrote ${outputFile}`);

    // Add to init
    const pyModuleName = moduleName.replace(/-/g, '_');
    initLines.push(`from .${pyModuleName} import (`);
    for (const entry of entries) {
      initLines.push(`    ${entry.name},`);
    }
    initLines.push(`)`);
    initLines.push('');
  }

  // Write __init__.py
  fs.writeFileSync(path.join(OUTPUT_DIR, '__init__.py'), initLines.join('\n'), 'utf-8');
  console.log('  Wrote __init__.py');
  console.log('Done.');
}

main().catch(console.error);
