const fs = require('fs');
const path = require('path');

const rootDirectory = path.join(__dirname, '..', '..');
const serviceManifestPath = path.join(rootDirectory, 'Common', 'ServiceManifest.json');
const classesDirectory = path.join(rootDirectory, 'Common', 'Classes');

// ─── Constants ────────────────────────────────────────────────────────────────

const BASIC_DATATYPES = new Set(['int', 'float', 'string', 'boolean', 'object', 'array', 'date', 'bytes']);
const SUPPORTED_ACCESS_LEVELS = new Set(['public', 'private', 'protected']);
const BASE_MEMBER_KEYS = new Set(['defaultValue', 'datatype', 'access', 'constant', 'id', 'classRelativePath']);

const NUMERIC_CONSTRAINT_KEYS = new Set(['min', 'max']);
const STRING_CONSTRAINT_KEYS = new Set(['minLength', 'maxLength', 'pattern', 'allowedValues', 'trim']);
const ARRAY_CONSTRAINT_KEYS = new Set(['minItems', 'maxItems']);

const PYTHON_BASIC_TYPE_MAP =
{
    int:     'int',
    float:   'float',
    string:  'str',
    boolean: 'bool',
    object:  'dict',
    array:   'list',
    date:    'datetime',
    bytes:   'bytes'
};

// ─── Datatype Parsing ─────────────────────────────────────────────────────────

function parseDatatypeString(datatypeStr)
{
    if (!datatypeStr) return null;

    datatypeStr = datatypeStr.trim();

    if (datatypeStr.startsWith('enum:'))
    {
        const enumName = datatypeStr.slice(5).trim();
        return { kind: 'enum', enumName };
    }

    if (datatypeStr.startsWith('class:'))
    {
        const className = datatypeStr.slice(6).trim();
        return { kind: 'class', className };
    }

    const arrayWithTypeMatch = datatypeStr.match(/^array<(.+)>$/);

    if (arrayWithTypeMatch)
    {
        const innerParsed = parseDatatypeString(arrayWithTypeMatch[1].trim());
        return { kind: 'array', innerType: innerParsed };
    }

    if (BASIC_DATATYPES.has(datatypeStr))
    {
        return { kind: datatypeStr, innerType: null };
    }

    return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateDatatypeString(datatypeStr, context)
{
    if (!datatypeStr) return [];

    const parsed = parseDatatypeString(datatypeStr);

    if (parsed === null)
    {
        return [
            `${context}: unsupported datatype "${datatypeStr}". ` +
            `Supported: ${[...BASIC_DATATYPES].join(', ')}, enum:<Name>, class:<Name>, array<type>`
        ];
    }

    if (parsed.kind === 'enum')
    {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(parsed.enumName))
        {
            return [`${context}: enum name "${parsed.enumName}" must be PascalCase (e.g. "enum:QuestionTypes")`];
        }
    }

    if (parsed.kind === 'class')
    {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(parsed.className))
        {
            return [`${context}: class name "${parsed.className}" must be PascalCase (e.g. "class:TaskSettings")`];
        }
    }

    if (parsed.kind === 'array' && parsed.innerType === null && datatypeStr !== 'array')
    {
        const innerStr = datatypeStr.match(/^array<(.+)>$/)?.[1];
        return [`${context}: invalid array element type "${innerStr}"`];
    }

    return [];
}

function getAllowedKeysForParsedDatatype(parsedDatatype)
{
    const allowedKeys = new Set([...BASE_MEMBER_KEYS]);

    if (!parsedDatatype) return allowedKeys;

    const kind = parsedDatatype.kind;

    if (kind === 'int' || kind === 'float')
    {
        for (const key of NUMERIC_CONSTRAINT_KEYS) allowedKeys.add(key);
    }
    else if (kind === 'string')
    {
        for (const key of STRING_CONSTRAINT_KEYS) allowedKeys.add(key);
    }
    else if (kind === 'array')
    {
        for (const key of ARRAY_CONSTRAINT_KEYS) allowedKeys.add(key);
    }

    return allowedKeys;
}

function validateMember(memberName, memberDef, className)
{
    if (typeof memberDef !== 'object' || Array.isArray(memberDef) || memberDef === null)
    {
        return [`Class "${className}": member "${memberName}" must be a plain object`];
    }

    const errors = [];
    const datatypeStr = memberDef.datatype;
    const context = `Class "${className}", member "${memberName}"`;

    errors.push(...validateDatatypeString(datatypeStr, context));

    const parsedDatatype = datatypeStr ? parseDatatypeString(datatypeStr) : null;

    if (memberDef.access !== undefined && !SUPPORTED_ACCESS_LEVELS.has(memberDef.access))
    {
        errors.push(
            `${context}: invalid access level "${memberDef.access}". ` +
            `Must be one of: public, private, protected`
        );
    }

    if (memberDef.constant !== undefined && typeof memberDef.constant !== 'boolean')
    {
        errors.push(`${context}: "constant" must be a boolean`);
    }

    if (memberDef.id !== undefined)
    {
        if (typeof memberDef.id !== 'boolean')
        {
            errors.push(`${context}: "id" must be a boolean`);
        }
        else if (memberDef.id === true)
        {
            if (memberDef.constant === true)
            {
                errors.push(`${context}: "id" and "constant" cannot both be true — id fields are implicitly read-only`);
            }
            if (memberDef.defaultValue !== undefined)
            {
                errors.push(`${context}: "id" fields cannot have a "defaultValue" — the value is always auto-generated`);
            }
        }
    }

    const allowedKeys = getAllowedKeysForParsedDatatype(parsedDatatype);

    for (const key of Object.keys(memberDef))
    {
        if (!allowedKeys.has(key))
        {
            const suffix = datatypeStr
                ? ` for datatype "${datatypeStr}"`
                : ' (specify a datatype to enable type-specific constraints)';
            errors.push(`${context}: unknown property "${key}"${suffix}`);
        }
    }

    if (parsedDatatype && (parsedDatatype.kind === 'int' || parsedDatatype.kind === 'float'))
    {
        if (memberDef.min !== undefined && typeof memberDef.min !== 'number')
        {
            errors.push(`${context}: "min" must be a number`);
        }
        if (memberDef.max !== undefined && typeof memberDef.max !== 'number')
        {
            errors.push(`${context}: "max" must be a number`);
        }
        if (typeof memberDef.min === 'number' && typeof memberDef.max === 'number' && memberDef.min > memberDef.max)
        {
            errors.push(`${context}: "min" (${memberDef.min}) cannot exceed "max" (${memberDef.max})`);
        }
    }

    if (parsedDatatype && parsedDatatype.kind === 'string')
    {
        if (memberDef.minLength !== undefined && (!Number.isInteger(memberDef.minLength) || memberDef.minLength < 0))
        {
            errors.push(`${context}: "minLength" must be a non-negative integer`);
        }
        if (memberDef.maxLength !== undefined && (!Number.isInteger(memberDef.maxLength) || memberDef.maxLength < 0))
        {
            errors.push(`${context}: "maxLength" must be a non-negative integer`);
        }
        if (Number.isInteger(memberDef.minLength) && Number.isInteger(memberDef.maxLength) && memberDef.minLength > memberDef.maxLength)
        {
            errors.push(`${context}: "minLength" cannot exceed "maxLength"`);
        }
        if (memberDef.allowedValues !== undefined && !Array.isArray(memberDef.allowedValues))
        {
            errors.push(`${context}: "allowedValues" must be an array`);
        }
        if (memberDef.trim !== undefined && typeof memberDef.trim !== 'boolean')
        {
            errors.push(`${context}: "trim" must be a boolean`);
        }
        if (memberDef.pattern !== undefined && typeof memberDef.pattern !== 'string')
        {
            errors.push(`${context}: "pattern" must be a regex string`);
        }
    }

    if (parsedDatatype && parsedDatatype.kind === 'array')
    {
        if (memberDef.minItems !== undefined && (!Number.isInteger(memberDef.minItems) || memberDef.minItems < 0))
        {
            errors.push(`${context}: "minItems" must be a non-negative integer`);
        }
        if (memberDef.maxItems !== undefined && (!Number.isInteger(memberDef.maxItems) || memberDef.maxItems < 0))
        {
            errors.push(`${context}: "maxItems" must be a non-negative integer`);
        }
        if (Number.isInteger(memberDef.minItems) && Number.isInteger(memberDef.maxItems) && memberDef.minItems > memberDef.maxItems)
        {
            errors.push(`${context}: "minItems" cannot exceed "maxItems"`);
        }
    }

    return errors;
}

function validateClassDefinition(classDef, fileName)
{
    const errors = [];

    if (!classDef.name || typeof classDef.name !== 'string')
    {
        errors.push(`File "${fileName}": "name" is required and must be a non-empty string`);
    }
    else if (!/^[A-Z][A-Za-z0-9]*$/.test(classDef.name))
    {
        errors.push(`File "${fileName}": "name" must be PascalCase (letters/digits only, e.g. "TaskDescriptor")`);
    }

    if (!classDef.relativePath || typeof classDef.relativePath !== 'string')
    {
        errors.push(`File "${fileName}": "relativePath" is required and must be a non-empty string (e.g. "Globals/Model")`);
    }

    if (classDef.extends !== undefined)
    {
        const parentDef = classDef.extends;

        if (typeof parentDef !== 'object' || Array.isArray(parentDef) || parentDef === null)
        {
            errors.push(`File "${fileName}": "extends" must be a plain object`);
        }
        else
        {
            if (!parentDef.name || typeof parentDef.name !== 'string')
            {
                errors.push(`File "${fileName}": "extends.name" is required and must be a non-empty string`);
            }
            else if (!/^[A-Z][A-Za-z0-9]*$/.test(parentDef.name))
            {
                errors.push(`File "${fileName}": "extends.name" must be PascalCase (e.g. "TaskSettings")`);
            }

            if (!parentDef.relativePath || typeof parentDef.relativePath !== 'string')
            {
                errors.push(`File "${fileName}": "extends.relativePath" is required and must be a non-empty string (e.g. "Globals/Model")`);
            }

            const allowedExtendsKeys = new Set(['name', 'relativePath']);

            for (const key of Object.keys(parentDef))
            {
                if (!allowedExtendsKeys.has(key))
                {
                    errors.push(`File "${fileName}": "extends" has unknown key "${key}". Allowed: name, relativePath`);
                }
            }
        }
    }

    if (classDef.services !== undefined)
    {
        if (!Array.isArray(classDef.services))
        {
            errors.push(`File "${fileName}": "services" must be an array of service name strings`);
        }
        else if (classDef.services.length === 0)
        {
            errors.push(`File "${fileName}": "services" must contain at least one entry if specified`);
        }
        else
        {
            for (const entry of classDef.services)
            {
                if (typeof entry !== 'string' || entry.trim() === '')
                {
                    errors.push(`File "${fileName}": every entry in "services" must be a non-empty string`);
                    break;
                }
            }
        }
    }

    if (classDef.imports !== undefined)
    {
        if (!Array.isArray(classDef.imports))
        {
            errors.push(`File "${fileName}": "imports" must be an array`);
        }
        else
        {
            classDef.imports.forEach((importGroup, idx) =>
            {
                const ctx = `File "${fileName}": imports[${idx}]`;

                if (typeof importGroup !== 'object' || Array.isArray(importGroup) || importGroup === null)
                {
                    errors.push(`${ctx} must be a plain object`);
                    return;
                }

                if (!importGroup.relativePath || typeof importGroup.relativePath !== 'string')
                {
                    errors.push(`${ctx}: "relativePath" is required and must be a non-empty string`);
                }

                if (importGroup.default !== undefined && (typeof importGroup.default !== 'string' || importGroup.default.trim() === ''))
                {
                    errors.push(`${ctx}: "default" must be a non-empty string`);
                }

                const hasDefault = typeof importGroup.default === 'string' && importGroup.default.trim() !== '';
                const hasEntities = Array.isArray(importGroup.entities) && importGroup.entities.length > 0;

                if (!hasDefault && !hasEntities)
                {
                    errors.push(`${ctx}: at least one of "default" or "entities" must be provided`);
                }
                else if (hasEntities)
                {
                    for (const entity of importGroup.entities)
                    {
                        if (typeof entity !== 'string' || entity.trim() === '')
                        {
                            errors.push(`${ctx}: every entry in "entities" must be a non-empty string`);
                            break;
                        }
                    }
                }

                const allowedImportKeys = new Set(['relativePath', 'default', 'entities']);
                for (const key of Object.keys(importGroup))
                {
                    if (!allowedImportKeys.has(key))
                    {
                        errors.push(`${ctx}: unknown key "${key}". Allowed: relativePath, default, entities`);
                    }
                }
            });
        }
    }

    if (classDef.members === undefined || classDef.members === null)
    {
        errors.push(`File "${fileName}": "members" is required`);
    }
    else if (typeof classDef.members !== 'object' || Array.isArray(classDef.members))
    {
        errors.push(`File "${fileName}": "members" must be a plain object`);
    }
    else if (Object.keys(classDef.members).length === 0)
    {
        errors.push(`File "${fileName}": "members" must contain at least one entry`);
    }
    else
    {
        for (const [memberName, memberDef] of Object.entries(classDef.members))
        {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(memberName))
            {
                errors.push(`File "${fileName}": member name "${memberName}" is not a valid identifier`);
            }
            else
            {
                errors.push(...validateMember(memberName, memberDef, classDef.name));
            }
        }
    }

    return errors;
}

// ─── Shared Utilities ─────────────────────────────────────────────────────────

function toSnakeCase(str)
{
    return str
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toLowerCase();
}

function toPascalCase(str)
{
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function toJsEnumVarName(enumName)
{
    return enumName.charAt(0).toLowerCase() + enumName.slice(1);
}

function indentation(level)
{
    return '    '.repeat(level);
}

function isAccessControlled(memberDef)
{
    const access = memberDef.access || 'private';
    return access === 'private' || access === 'protected';
}

function toPythonLiteral(value)
{
    if (value === null || value === undefined) return 'None';
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return `[${value.map(toPythonLiteral).join(', ')}]`;
    if (typeof value === 'object')
    {
        const pairs = Object.entries(value).map(([key, val]) => `'${key}': ${toPythonLiteral(val)}`);
        return `{${pairs.join(', ')}}`;
    }
    return String(value);
}

function getJsLiteralForDefault(memberDef)
{
    const value = memberDef.defaultValue;
    const parsed = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;

    if (parsed && parsed.kind === 'date')
    {
        if (value === undefined || value === null || value === 'now') return 'new Date()';
        return `new Date('${value}')`;
    }

    if (parsed && parsed.kind === 'bytes')
    {
        return 'new Uint8Array(0)';
    }

    if (value === undefined || value === null) return 'null';
    if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function getPythonLiteralForDefault(memberDef)
{
    if (memberDef.defaultValue === undefined)
    {
        return 'None';
    }

    const datatypeStr = memberDef.datatype;
    const parsedDatatype = datatypeStr ? parseDatatypeString(datatypeStr) : null;

    if (parsedDatatype && parsedDatatype.kind === 'date')
    {
        if (memberDef.defaultValue === undefined || memberDef.defaultValue === null || memberDef.defaultValue === 'now')
        {
            return 'datetime.now()';
        }
        return `datetime.fromisoformat('${memberDef.defaultValue}')`;
    }

    if (parsedDatatype && parsedDatatype.kind === 'bytes')
    {
        return "b''";
    }

    if (parsedDatatype && parsedDatatype.kind === 'enum')
    {
        const enumName = parsedDatatype.enumName;

        if (typeof memberDef.defaultValue === 'string')
        {
            return `${enumName}.${memberDef.defaultValue}`;
        }

        return `${enumName}(${memberDef.defaultValue})`;
    }

    if (parsedDatatype && parsedDatatype.kind === 'array' && parsedDatatype.innerType && parsedDatatype.innerType.kind === 'enum')
    {
        const enumName = parsedDatatype.innerType.enumName;

        if (Array.isArray(memberDef.defaultValue))
        {
            const values = memberDef.defaultValue.map(v =>
            {
                if (typeof v === 'string')
                {
                    return `${enumName}.${v}`;
                }

                return `${enumName}(${v})`;
            });

            return `[${values.join(', ')}]`;
        }
    }

    return toPythonLiteral(memberDef.defaultValue);
}

// ─── Type Hint Helpers ────────────────────────────────────────────────────────

function getPythonTypeHint(parsedDatatype, selfClassName = null)
{
    if (!parsedDatatype) return 'Any';
    if (parsedDatatype.kind === 'enum') return parsedDatatype.enumName;

    if (parsedDatatype.kind === 'class')
    {
        const className = parsedDatatype.className;
        return (selfClassName && className === selfClassName) ? `'${className}'` : className;
    }

    if (parsedDatatype.kind === 'array')
    {
        if (parsedDatatype.innerType)
        {
            return `List[${getPythonTypeHint(parsedDatatype.innerType, selfClassName)}]`;
        }
        return 'list';
    }

    return PYTHON_BASIC_TYPE_MAP[parsedDatatype.kind] || 'Any';
}

function collectEnumNamesFromMembers(members)
{
    const enumNames = new Set();

    for (const memberDef of Object.values(members))
    {
        const datatypeStr = memberDef.datatype;
        if (!datatypeStr) continue;

        const parsed = parseDatatypeString(datatypeStr);
        if (!parsed) continue;

        if (parsed.kind === 'enum')
        {
            enumNames.add(parsed.enumName);
        }
        else if (parsed.kind === 'array' && parsed.innerType && parsed.innerType.kind === 'enum')
        {
            enumNames.add(parsed.innerType.enumName);
        }
    }

    return enumNames;
}

// Returns Map<className, relativePath> for all class: typed members.
// relativePath is read from memberDef.classRelativePath when present.
function collectClassRefsFromMembers(members)
{
    const classRefs = new Map();

    for (const memberDef of Object.values(members))
    {
        const datatypeStr = memberDef.datatype;
        if (!datatypeStr) continue;

        const parsed = parseDatatypeString(datatypeStr);
        if (!parsed) continue;

        const refPath = memberDef.classRelativePath || null;

        if (parsed.kind === 'class')
        {
            classRefs.set(parsed.className, refPath);
        }
        else if (parsed.kind === 'array' && parsed.innerType && parsed.innerType.kind === 'class')
        {
            classRefs.set(parsed.innerType.className, refPath);
        }
    }

    return classRefs;
}

function hasParameterizedArray(members)
{
    for (const memberDef of Object.values(members))
    {
        const datatypeStr = memberDef.datatype;
        if (!datatypeStr) continue;

        const parsed = parseDatatypeString(datatypeStr);
        if (parsed && parsed.kind === 'array' && parsed.innerType)
        {
            return true;
        }
    }
    return false;
}

function hasIdMembers(members)
{
    return Object.values(members).some(memberDef => memberDef.id === true);
}

// ─── Serialization Expression Builders ───────────────────────────────────────
// These return the code expression (as a string) for reading/writing one field
// during toJson / fromJson, per language.

function buildJsToJsonExpression(memberName, memberDef, parsedDatatype)
{
    const access = memberDef.access || 'private';
    const isControlled = access === 'private' || access === 'protected';
    const valueExpr = isControlled
        ? `this.get${toPascalCase(memberName)}()`
        : `this.${memberName}`;

    if (!parsedDatatype) return valueExpr;

    if (parsedDatatype.kind === 'enum')
    {
        return `${valueExpr} !== null ? Number(${valueExpr}) : null`;
    }

    if (parsedDatatype.kind === 'array' && parsedDatatype.innerType && parsedDatatype.innerType.kind === 'enum')
    {
        return `${valueExpr} !== null ? ${valueExpr}.map(item => Number(item)) : null`;
    }

    if (parsedDatatype.kind === 'class')
    {
        return `${valueExpr} !== null ? ${valueExpr}.toJson() : null`;
    }

    if (parsedDatatype.kind === 'array' && parsedDatatype.innerType && parsedDatatype.innerType.kind === 'class')
    {
        return `${valueExpr} !== null ? ${valueExpr}.map(item => item.toJson()) : null`;
    }

    if (parsedDatatype.kind === 'date')
    {
        return `${valueExpr} !== null ? ${valueExpr}.toISOString() : null`;
    }

    if (parsedDatatype.kind === 'bytes')
    {
        return (
            `${valueExpr} != null ? ` +
            `(typeof Buffer !== 'undefined' ? ${valueExpr}.toString('base64') : (() => ` +
            `{ const bytes = ${valueExpr}; const chunkSize = 8192; let binaryString = ''; ` +
            `for (let offset = 0; offset < bytes.length; offset += chunkSize) ` +
            `{ binaryString += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)); } ` +
            `return btoa(binaryString); })()) : null`
        );
    }

    return valueExpr;
}

function buildJsFromJsonExpression(memberName, memberDef, parsedDatatype)
{
    const rawExpr = `json.${memberName}`;

    if (!parsedDatatype || memberDef.id === true)
    {
        return `${rawExpr} ?? null`;
    }

    if (parsedDatatype.kind === 'class')
    {
        return `${rawExpr} != null ? ${parsedDatatype.className}.fromJson(${rawExpr}) : null`;
    }

    if (parsedDatatype.kind === 'array' && parsedDatatype.innerType && parsedDatatype.innerType.kind === 'class')
    {
        const innerClassName = parsedDatatype.innerType.className;
        return `${rawExpr} != null ? ${rawExpr}.map(item => ${innerClassName}.fromJson(item)) : null`;
    }

    if (parsedDatatype.kind === 'date')
    {
        return `${rawExpr} != null ? new Date(${rawExpr}) : null`;
    }

    if (parsedDatatype.kind === 'bytes')
    {
        return `${rawExpr} != null ? (typeof Buffer !== 'undefined' ? Buffer.from(${rawExpr}, 'base64') : Uint8Array.from(atob(${rawExpr}), c => c.charCodeAt(0))) : new Uint8Array(0)`;
    }

    return `${rawExpr} ?? null`;
}

function buildPythonToJsonExpression(memberName, memberDef, parsedDatatype)
{
    const access = memberDef.access || 'private';
    const snakeName = toSnakeCase(memberName);
    const isControlled = access === 'private' || access === 'protected';
    const valueExpr = isControlled ? `self.get_${snakeName}()` : `self.${snakeName}`;

    if (!parsedDatatype) return valueExpr;

    if (parsedDatatype.kind === 'enum')
    {
        return `int(${valueExpr}.value) if ${valueExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'array' && parsedDatatype.innerType && parsedDatatype.innerType.kind === 'enum')
    {
        return `[int(item.value) for item in ${valueExpr}] if ${valueExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'class')
    {
        return `${valueExpr}.to_json() if ${valueExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'array' && parsedDatatype.innerType && parsedDatatype.innerType.kind === 'class')
    {
        return `[item.to_json() for item in ${valueExpr}] if ${valueExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'date')
    {
        return `${valueExpr}.isoformat() if ${valueExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'bytes')
    {
        return `base64.b64encode(${valueExpr}).decode('utf-8') if ${valueExpr} is not None else None`;
    }

    return valueExpr;
}

function buildPythonFromJsonExpression(memberName, memberDef, parsedDatatype)
{
    const snakeName = toSnakeCase(memberName);
    const rawExpr = `data.get('${memberName}')`;

    if (!parsedDatatype) return rawExpr;

    if (parsedDatatype.kind === 'enum')
    {
        return `${parsedDatatype.enumName}(${rawExpr}) if ${rawExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'array' && parsedDatatype.innerType && parsedDatatype.innerType.kind === 'enum')
    {
        const innerEnumName = parsedDatatype.innerType.enumName;
        return `[${innerEnumName}(v) for v in ${rawExpr}] if ${rawExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'class')
    {
        return `${parsedDatatype.className}.from_json(${rawExpr}) if ${rawExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'array' && parsedDatatype.innerType && parsedDatatype.innerType.kind === 'class')
    {
        const innerClassName = parsedDatatype.innerType.className;
        return `[${innerClassName}.from_json(v) for v in ${rawExpr}] if ${rawExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'date')
    {
        return `datetime.fromisoformat(${rawExpr}) if ${rawExpr} is not None else None`;
    }

    if (parsedDatatype.kind === 'bytes')
    {
        return `base64.b64decode(${rawExpr}) if ${rawExpr} is not None else b''`;
    }

    return rawExpr;
}

// ─── Backing Field Name Helpers ───────────────────────────────────────────────

function getJsBackingFieldName(memberName, memberDef)
{
    const access = memberDef.access || 'private';
    return access === 'protected' ? `_${memberName}` : `#${memberName}`;
}

function getPythonBackingFieldName(memberName, memberDef)
{
    const access = memberDef.access || 'private';
    const snakeName = toSnakeCase(memberName);
    return access === 'protected' ? `_${snakeName}` : `__${snakeName}`;
}

// ─── Import Path Helpers ──────────────────────────────────────────────────────

function computeJsParentImportPath(parentRelativePath, parentName, classRelativePath)
{
    const parentFilePath = path.join(parentRelativePath, parentName);
    const relativeImportPath = path.relative(classRelativePath, parentFilePath).replace(/\\/g, '/');
    return relativeImportPath.startsWith('.') ? relativeImportPath : `./${relativeImportPath}`;
}

function computePythonParentImportPath(parentRelativePath, parentName)
{
    const dotSeparatedModulePath = parentRelativePath.replace(/[\\/]/g, '.');
    return `${dotSeparatedModulePath}.${parentName}`;
}

// ─── JS Enum Import Path ──────────────────────────────────────────────────────

function computeJsEnumImportPath(enumName, classRelativePath)
{
    const enumsDirectoryPath = path.join('Globals', 'Enumerations');
    const relativePathToEnumsDir = path.relative(classRelativePath, enumsDirectoryPath);
    const forwardSlashedPath = relativePathToEnumsDir.replace(/\\/g, '/');
    return `${forwardSlashedPath}/${enumName}`;
}

// ─── JavaScript Setter Body ───────────────────────────────────────────────────

function buildJsSetterLines(memberDef, parsedDatatype, indentLevel)
{
    const lines = [];
    const pad = (extra) => indentation(indentLevel + extra);

    if (!parsedDatatype) return lines;

    const kind = parsedDatatype.kind;

    if (kind === 'int' || kind === 'float')
    {
        const parseFunction = kind === 'int' ? 'parseInt(value, 10)' : 'parseFloat(value)';

        lines.push(`${pad(0)}if (value !== null)`);
        lines.push(`${pad(0)}{`);
        lines.push(`${pad(1)}value = ${parseFunction};`);
        lines.push(`${pad(1)}if (isNaN(value))`);
        lines.push(`${pad(1)}{`);
        lines.push(`${pad(2)}value = ${getJsLiteralForDefault(memberDef)};`);
        lines.push(`${pad(1)}}`);

        if (memberDef.min !== undefined || memberDef.max !== undefined)
        {
            lines.push(`${pad(1)}else`);
            lines.push(`${pad(1)}{`);

            if (memberDef.min !== undefined && memberDef.max !== undefined)
            {
                lines.push(`${pad(2)}value = Math.min(Math.max(value, ${memberDef.min}), ${memberDef.max});`);
            }
            else if (memberDef.min !== undefined)
            {
                lines.push(`${pad(2)}value = Math.max(value, ${memberDef.min});`);
            }
            else
            {
                lines.push(`${pad(2)}value = Math.min(value, ${memberDef.max});`);
            }

            lines.push(`${pad(1)}}`);
        }

        lines.push(`${pad(0)}}`);
    }
    else if (kind === 'string')
    {
        lines.push(`${pad(0)}if (value !== null)`);
        lines.push(`${pad(0)}{`);
        lines.push(`${pad(1)}value = String(value);`);

        if (memberDef.trim)
        {
            lines.push(`${pad(1)}value = value.trim();`);
        }
        if (memberDef.maxLength !== undefined)
        {
            lines.push(`${pad(1)}if (value.length > ${memberDef.maxLength})`);
            lines.push(`${pad(1)}{`);
            lines.push(`${pad(2)}value = value.slice(0, ${memberDef.maxLength});`);
            lines.push(`${pad(1)}}`);
        }
        if (memberDef.minLength !== undefined)
        {
            lines.push(`${pad(1)}if (value.length < ${memberDef.minLength})`);
            lines.push(`${pad(1)}{`);
            lines.push(`${pad(2)}value = null;`);
            lines.push(`${pad(1)}}`);
        }
        if (memberDef.pattern)
        {
            lines.push(`${pad(1)}if (value !== null && !/${memberDef.pattern}/.test(value))`);
            lines.push(`${pad(1)}{`);
            lines.push(`${pad(2)}value = null;`);
            lines.push(`${pad(1)}}`);
        }
        if (memberDef.allowedValues && memberDef.allowedValues.length > 0)
        {
            lines.push(`${pad(1)}const allowedValues = ${JSON.stringify(memberDef.allowedValues)};`);
            lines.push(`${pad(1)}if (!allowedValues.includes(value))`);
            lines.push(`${pad(1)}{`);
            lines.push(`${pad(2)}value = allowedValues[0] ?? null;`);
            lines.push(`${pad(1)}}`);
        }

        lines.push(`${pad(0)}}`);
    }
    else if (kind === 'boolean')
    {
        lines.push(`${pad(0)}if (value !== null)`);
        lines.push(`${pad(0)}{`);
        lines.push(`${pad(1)}value = Boolean(value);`);
        lines.push(`${pad(0)}}`);
    }
    else if (kind === 'array')
    {
        lines.push(`${pad(0)}if (value !== null)`);
        lines.push(`${pad(0)}{`);
        lines.push(`${pad(1)}if (!Array.isArray(value))`);
        lines.push(`${pad(1)}{`);
        lines.push(`${pad(2)}value = null;`);
        lines.push(`${pad(1)}}`);

        if (memberDef.maxItems !== undefined)
        {
            lines.push(`${pad(1)}else if (value.length > ${memberDef.maxItems})`);
            lines.push(`${pad(1)}{`);
            lines.push(`${pad(2)}value = value.slice(0, ${memberDef.maxItems});`);
            lines.push(`${pad(1)}}`);
        }
        if (memberDef.minItems !== undefined)
        {
            lines.push(`${pad(1)}if (value !== null && value.length < ${memberDef.minItems})`);
            lines.push(`${pad(1)}{`);
            lines.push(`${pad(2)}value = null;`);
            lines.push(`${pad(1)}}`);
        }

        lines.push(`${pad(0)}}`);
    }
    else if (kind === 'enum')
    {
        const enumName = parsedDatatype.enumName;
        const enumVarName = toJsEnumVarName(enumName);
        lines.push(`${pad(0)}if (value !== null)`);
        lines.push(`${pad(0)}{`);
        lines.push(`${pad(1)}const enumValues = Object.values(${enumVarName});`);
        lines.push(`${pad(1)}if (!enumValues.includes(value))`);
        lines.push(`${pad(1)}{`);
        lines.push(`${pad(2)}value = enumValues[0] ?? null;`);
        lines.push(`${pad(1)}}`);
        lines.push(`${pad(0)}}`);
    }
    else if (kind === 'date')
    {
        lines.push(`${pad(0)}if (value !== null)`);
        lines.push(`${pad(0)}{`);
        lines.push(`${pad(1)}value = value instanceof Date ? value : new Date(value);`);
        lines.push(`${pad(1)}if (isNaN(value.getTime()))`);
        lines.push(`${pad(1)}{`);
        lines.push(`${pad(2)}value = new Date();`);
        lines.push(`${pad(1)}}`);
        lines.push(`${pad(0)}}`);
        lines.push(`${pad(0)}else`);
        lines.push(`${pad(0)}{`);
        lines.push(`${pad(1)}value = new Date();`);
        lines.push(`${pad(0)}}`);
    }
    else if (kind === 'bytes')
    {
        lines.push(`${pad(0)}if (value !== null && value !== undefined)`);
        lines.push(`${pad(0)}{`);
        lines.push(`${pad(1)}if (typeof value === 'string')`);
        lines.push(`${pad(1)}{`);
        lines.push(`${pad(2)}value = typeof Buffer !== 'undefined'`);
        lines.push(`${pad(3)}? Buffer.from(value, 'base64')`);
        lines.push(`${pad(3)}: Uint8Array.from(atob(value), c => c.charCodeAt(0));`);
        lines.push(`${pad(1)}}`);
        lines.push(`${pad(1)}else if (!(value instanceof Uint8Array))`);
        lines.push(`${pad(1)}{`);
        lines.push(`${pad(2)}value = new Uint8Array(0);`);
        lines.push(`${pad(1)}}`);
        lines.push(`${pad(0)}}`);
        lines.push(`${pad(0)}else`);
        lines.push(`${pad(0)}{`);
        lines.push(`${pad(1)}value = new Uint8Array(0);`);
        lines.push(`${pad(0)}}`);
    }

    return lines;
}

// ─── Inheritance Resolution ──────────────────────────────────────────────────

function loadClassDefinitionMap()
{
    const classDefMap = new Map();

    if (!fs.existsSync(classesDirectory))
    {
        return classDefMap;
    }

    const classFiles = fs.readdirSync(classesDirectory).filter(file => file.endsWith('.json'));

    for (const classFile of classFiles)
    {
        const classFilePath = path.join(classesDirectory, classFile);

        try
        {
            const classDef = JSON.parse(fs.readFileSync(classFilePath, 'utf8'));

            if (classDef.name && typeof classDef.name === 'string')
            {
                classDefMap.set(classDef.name, classDef);
            }
        }
        catch (e)
        {
            // Skip unparseable files — validation in run() will report them
        }
    }

    return classDefMap;
}

function getInheritedMemberEntries(classDef, classDefMap)
{
    const ancestorChain = [];
    let current = classDef;

    while (current.extends)
    {
        const parentName = current.extends.name;
        const parentDef = classDefMap.get(parentName);

        if (!parentDef)
        {
            console.warn(`  [WARN] Parent class "${parentName}" not found in class definitions — cannot resolve inherited members`);
            break;
        }

        ancestorChain.unshift(parentDef);
        current = parentDef;
    }

    const inheritedEntries = [];

    for (const ancestorDef of ancestorChain)
    {
        for (const [memberName, memberDef] of Object.entries(ancestorDef.members))
        {
            inheritedEntries.push([memberName, memberDef]);
        }
    }

    return inheritedEntries;
}

// ─── JavaScript Class Generation ─────────────────────────────────────────────

function generateJsClass(classDef, mode, inheritedMemberEntries)
{
    const { name, members, relativePath } = classDef;
    const parentDef = classDef.extends || null;
    const memberEntries = Object.entries(members);
    const controlledMembers = memberEntries.filter(([, memberDef]) => isAccessControlled(memberDef));
    const enumNames = collectEnumNamesFromMembers(members);
    const classRefs = collectClassRefsFromMembers(members);
    const classHasIdMembers = hasIdMembers(members);

    // Also collect class refs from inherited members — needed for fromJson expressions
    const inheritedClassRefs = new Map();

    for (const [, memberDef] of inheritedMemberEntries)
    {
        const datatypeStr = memberDef.datatype;
        if (!datatypeStr) continue;

        const parsed = parseDatatypeString(datatypeStr);
        if (!parsed) continue;

        const refPath = memberDef.classRelativePath || null;

        if (parsed.kind === 'class' && !classRefs.has(parsed.className))
        {
            inheritedClassRefs.set(parsed.className, refPath);
        }
        else if (parsed.kind === 'array' && parsed.innerType && parsed.innerType.kind === 'class' && !classRefs.has(parsed.innerType.className))
        {
            inheritedClassRefs.set(parsed.innerType.className, refPath);
        }
    }

    let output = '';

    // Imports
    if (classHasIdMembers && mode !== 'html5')
    {
        output += `const crypto = require('crypto');\n\n`;
    }

    if (parentDef)
    {
        const parentImportPath = computeJsParentImportPath(parentDef.relativePath, parentDef.name, relativePath);

        if (mode === 'html5')
        {
            output += `import ${parentDef.name} from '${parentImportPath}.js';\n`;
        }
        else
        {
            output += `const ${parentDef.name} = require('${parentImportPath}');\n`;
        }
    }

    for (const enumName of enumNames)
    {
        const importPath = computeJsEnumImportPath(enumName, relativePath);
        const enumVarName = toJsEnumVarName(enumName);

        if (mode === 'html5')
        {
            output += `import { ${enumVarName} } from '${importPath}.js';\n`;
        }
        else
        {
            output += `const { ${enumVarName} } = require('${importPath}');\n`;
        }
    }

    const allClassRefs = new Map([...classRefs, ...inheritedClassRefs]);

    for (const [refClassName, refRelativePath] of allClassRefs)
    {
        if (refClassName === name) continue;

        if (refRelativePath)
        {
            const importPath = computeJsParentImportPath(refRelativePath, refClassName, relativePath);

            if (mode === 'html5')
            {
                output += `import ${refClassName} from '${importPath}.js';\n`;
            }
            else
            {
                output += `const ${refClassName} = require('${importPath}');\n`;
            }
        }
    }

    const manualImports = Array.isArray(classDef.imports) ? classDef.imports : [];

    for (const importGroup of manualImports)
    {
        const importPath = computeJsParentImportPath(importGroup.relativePath, '', relativePath)
            .replace(/\/$/, '');
        const defaultImport = importGroup.default || null;
        const namedEntities = Array.isArray(importGroup.entities) && importGroup.entities.length > 0
            ? importGroup.entities
            : null;

        let importSpec;

        if (defaultImport && namedEntities)
        {
            importSpec = `${defaultImport}, { ${namedEntities.join(', ')} }`;
        }
        else if (defaultImport)
        {
            importSpec = defaultImport;
        }
        else
        {
            importSpec = `{ ${namedEntities.join(', ')} }`;
        }

        if (mode === 'html5')
        {
            output += `import ${importSpec} from '${importPath}.js';\n`;
        }
        else
        {
            // CommonJS: default becomes a plain require(), named become destructured
            if (defaultImport && namedEntities)
            {
                output += `const ${defaultImport} = require('${importPath}');\n`;
                output += `const { ${namedEntities.join(', ')} } = ${defaultImport};\n`;
            }
            else if (defaultImport)
            {
                output += `const ${defaultImport} = require('${importPath}');\n`;
            }
            else
            {
                output += `const { ${namedEntities.join(', ')} } = require('${importPath}');\n`;
            }
        }
    }

    if (parentDef || enumNames.size > 0 || allClassRefs.size > 0 || manualImports.length > 0)
    {
        output += '\n';
    }

    const classDeclaration = parentDef
        ? `class ${name} extends ${parentDef.name}`
        : `class ${name}`;

    output += `${classDeclaration}\n{\n`;

    // Private/protected backing field declarations
    for (const [memberName, memberDef] of controlledMembers)
    {
        output += `${indentation(1)}${getJsBackingFieldName(memberName, memberDef)};\n`;
    }

    if (controlledMembers.length > 0)
    {
        output += '\n';
    }

    // Constructor — inherited non-id params come first, then own non-id params.
    // Uses destructured object parameters so order is irrelevant at the call site.
    const inheritedNonIdEntries = inheritedMemberEntries.filter(([, memberDef]) => memberDef.id !== true);
    const ownNonIdEntries = memberEntries.filter(([, memberDef]) => memberDef.id !== true);
    const allNonIdEntries = [...inheritedNonIdEntries, ...ownNonIdEntries];

    const constructorParamList = allNonIdEntries
        .map(([memberName, memberDef]) => `${memberName} = ${getJsLiteralForDefault(memberDef)}`)
        .join(', ');

    const constructorSignature = allNonIdEntries.length > 0
        ? `{${constructorParamList}} = {}`
        : '';

    output += `${indentation(1)}constructor(${constructorSignature})\n${indentation(1)}{\n`;

    if (parentDef)
    {
        if (inheritedNonIdEntries.length > 0)
        {
            const superArgList = inheritedNonIdEntries
                .map(([memberName]) => memberName)
                .join(', ');
            output += `${indentation(2)}super({${superArgList}});\n`;
        }
        else
        {
            output += `${indentation(2)}super();\n`;
        }
    }

    // Only handle OWN members in the constructor body — inherited members are handled by super()
    for (const [memberName, memberDef] of memberEntries)
    {
        const access = memberDef.access || 'private';
        const isId = memberDef.id === true;
        const isConstant = memberDef.constant === true;
        const isControlled = access === 'private' || access === 'protected';
        const uuidCall = mode === 'html5' ? 'crypto.randomUUID()' : 'crypto.randomUUID()';

        if (isId)
        {
            // Id fields are never in the constructor params — always auto-generated
            const backingExpr = isControlled
                ? `this.${getJsBackingFieldName(memberName, memberDef)}`
                : `this.${memberName}`;
            output += `${indentation(2)}${backingExpr} = ${uuidCall};\n`;
        }
        else if (access === 'public')
        {
            output += `${indentation(2)}this.${memberName} = ${memberName};\n`;
        }
        else if (isConstant)
        {
            output += `${indentation(2)}this.${getJsBackingFieldName(memberName, memberDef)} = ${memberName};\n`;
        }
        else
        {
            output += `${indentation(2)}this.set${toPascalCase(memberName)}(${memberName});\n`;
        }
    }

    output += `${indentation(1)}}\n`;

    // Getters and setters for access-controlled members
    for (const [memberName, memberDef] of controlledMembers)
    {
        const backingField = getJsBackingFieldName(memberName, memberDef);
        const isId = memberDef.id === true;
        const isConstant = memberDef.constant === true;
        const parsedDatatype = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
        const getterMethodName = `get${toPascalCase(memberName)}`;
        const setterMethodName = `set${toPascalCase(memberName)}`;

        output += '\n';

        output += `${indentation(1)}${getterMethodName}()\n${indentation(1)}{\n`;
        output += `${indentation(2)}return this.${backingField};\n`;
        output += `${indentation(1)}}\n`;

        // No setter for id or constant members
        if (!isId && !isConstant)
        {
            output += '\n';
            output += `${indentation(1)}${setterMethodName}(value)\n${indentation(1)}{\n`;

            const setterBodyLines = buildJsSetterLines(memberDef, parsedDatatype, 2);

            if (setterBodyLines.length > 0)
            {
                output += setterBodyLines.join('\n') + '\n';
            }

            output += `${indentation(2)}this.${backingField} = value;\n`;
            output += `${indentation(1)}}\n`;
        }
    }

    // toMetadataJson — all non-bytes own members; generated only when bytes members exist.
    // toJson spreads toMetadataJson() so metadata is never duplicated.
    const ownBytesEntries = memberEntries.filter(([, memberDef]) =>
    {
        const parsed = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
        return parsed && parsed.kind === 'bytes';
    });

    const parentHasBytesMembers = inheritedMemberEntries.some(([, memberDef]) =>
    {
        const parsed = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
        return parsed && parsed.kind === 'bytes';
    });

    const classHasBytesMembers = ownBytesEntries.length > 0 || parentHasBytesMembers;

    if (classHasBytesMembers)
    {
        const nonBytesEntries = memberEntries.filter(([, memberDef]) =>
        {
            const parsed = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
            return !(parsed && parsed.kind === 'bytes');
        });

        output += '\n';
        output += `${indentation(1)}toMetadataJson()\n${indentation(1)}{\n`;
        output += `${indentation(2)}return {\n`;

        if (parentDef)
        {
            const parentSpread = parentHasBytesMembers
                ? `...super.toMetadataJson(),`
                : `...super.toJson(),`;
            output += `${indentation(3)}${parentSpread}\n`;
        }

        for (const [memberName, memberDef] of nonBytesEntries)
        {
            const parsedDatatype = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
            const valueExpr = buildJsToJsonExpression(memberName, memberDef, parsedDatatype);
            output += `${indentation(3)}${memberName}: ${valueExpr},\n`;
        }

        output += `${indentation(2)}};\n`;
        output += `${indentation(1)}}\n`;
    }

    // toJson — own members only; parent members are included via super.toJson()
    output += '\n';
    output += `${indentation(1)}toJson()\n${indentation(1)}{\n`;
    output += `${indentation(2)}return {\n`;

    if (classHasBytesMembers)
    {
        output += `${indentation(3)}...this.toMetadataJson(),\n`;

        for (const [memberName, memberDef] of ownBytesEntries)
        {
            const parsedDatatype = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
            const valueExpr = buildJsToJsonExpression(memberName, memberDef, parsedDatatype);
            output += `${indentation(3)}${memberName}: ${valueExpr},\n`;
        }
    }
    else
    {
        if (parentDef)
        {
            output += `${indentation(3)}...super.toJson(),\n`;
        }

        for (const [memberName, memberDef] of memberEntries)
        {
            const parsedDatatype = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
            const valueExpr = buildJsToJsonExpression(memberName, memberDef, parsedDatatype);
            output += `${indentation(3)}${memberName}: ${valueExpr},\n`;
        }
    }

    output += `${indentation(2)}};\n`;
    output += `${indentation(1)}}\n`;

    // fromJson — static factory that restores ALL fields (inherited + own) including stored ids
    output += '\n';
    output += `${indentation(1)}static fromJson(json)\n${indentation(1)}{\n`;
    output += `${indentation(2)}const instance = new ${name}(`;

    const allFromJsonArgs = [...inheritedNonIdEntries, ...ownNonIdEntries]
        .map(([memberName, memberDef]) =>
        {
            const parsedDatatype = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
            return `${memberName}: ${buildJsFromJsonExpression(memberName, memberDef, parsedDatatype)}`;
        })
        .map(pair => `\n${indentation(3)}` + pair);

    if (allFromJsonArgs.length > 0)
    {
        output += `{${allFromJsonArgs.join(',')}\n${indentation(2)}}`;
    }

    output += `);\n`;

    // Restore ALL id fields from the entire hierarchy (inherited + own).
    // Parent _restoreId methods are available through inheritance.
    const inheritedIdEntries = inheritedMemberEntries.filter(([, memberDef]) => memberDef.id === true);
    const ownIdEntries = memberEntries.filter(([, memberDef]) => memberDef.id === true);
    const allIdEntries = [...inheritedIdEntries, ...ownIdEntries];

    for (const [memberName, memberDef] of allIdEntries)
    {
        const access = memberDef.access || 'private';
        const isControlled = access === 'private' || access === 'protected';

        if (isControlled)
        {
            output += `${indentation(2)}instance._restoreId_${memberName}(json.${memberName});\n`;
        }
        else
        {
            output += `${indentation(2)}instance.${memberName} = json.${memberName};\n`;
        }
    }

    output += `${indentation(2)}return instance;\n`;
    output += `${indentation(1)}}\n`;

    // Internal id-restore methods for OWN private/protected id fields only.
    // Parent classes define their own _restoreId methods which are inherited.
    for (const [memberName, memberDef] of ownIdEntries)
    {
        const access = memberDef.access || 'private';
        const isControlled = access === 'private' || access === 'protected';

        if (isControlled)
        {
            const backingField = getJsBackingFieldName(memberName, memberDef);
            output += '\n';
            output += `${indentation(1)}_restoreId_${memberName}(storedId)\n${indentation(1)}{\n`;
            output += `${indentation(2)}if (storedId !== undefined && storedId !== null)\n${indentation(2)}{\n`;
            output += `${indentation(3)}this.${backingField} = storedId;\n`;
            output += `${indentation(2)}}\n`;
            output += `${indentation(1)}}\n`;
        }
    }

    output += `}\n`;

    if (mode === 'html5')
    {
        output += `\nexport default ${name};\n`;
    }
    else
    {
        output += `\nmodule.exports = ${name};\n`;
    }

    return output;
}

// ─── Python Setter Body ───────────────────────────────────────────────────────

function buildPythonSetterLines(memberDef, parsedDatatype, indentLevel)
{
    const lines = [];
    const pad = (extra) => indentation(indentLevel + extra);

    if (!parsedDatatype) return lines;

    const kind = parsedDatatype.kind;

    if (kind === 'int' || kind === 'float')
    {
        const convertFunction = kind === 'int' ? 'int(value)' : 'float(value)';

        lines.push(`${pad(0)}if value is not None:`);
        lines.push(`${pad(1)}try:`);
        lines.push(`${pad(2)}value = ${convertFunction}`);

        if (memberDef.min !== undefined && memberDef.max !== undefined)
        {
            lines.push(`${pad(2)}value = max(${memberDef.min}, min(value, ${memberDef.max}))`);
        }
        else if (memberDef.min !== undefined)
        {
            lines.push(`${pad(2)}value = max(${memberDef.min}, value)`);
        }
        else if (memberDef.max !== undefined)
        {
            lines.push(`${pad(2)}value = min(value, ${memberDef.max})`);
        }

        lines.push(`${pad(1)}except (ValueError, TypeError):`);
        lines.push(`${pad(2)}value = ${getPythonLiteralForDefault(memberDef)}`);
    }
    else if (kind === 'string')
    {
        lines.push(`${pad(0)}if value is not None:`);
        lines.push(`${pad(1)}value = str(value)`);

        if (memberDef.trim)
        {
            lines.push(`${pad(1)}value = value.strip()`);
        }
        if (memberDef.maxLength !== undefined)
        {
            lines.push(`${pad(1)}if len(value) > ${memberDef.maxLength}:`);
            lines.push(`${pad(2)}value = value[:${memberDef.maxLength}]`);
        }
        if (memberDef.minLength !== undefined)
        {
            lines.push(`${pad(1)}if value is not None and len(value) < ${memberDef.minLength}:`);
            lines.push(`${pad(2)}value = None`);
        }
        if (memberDef.pattern)
        {
            lines.push(`${pad(1)}if value is not None and not re.match(r'${memberDef.pattern}', value):`);
            lines.push(`${pad(2)}value = None`);
        }
        if (memberDef.allowedValues && memberDef.allowedValues.length > 0)
        {
            lines.push(`${pad(1)}allowed_values = ${toPythonLiteral(memberDef.allowedValues)}`);
            lines.push(`${pad(1)}if value not in allowed_values:`);
            lines.push(`${pad(2)}value = allowed_values[0] if allowed_values else None`);
        }
    }
    else if (kind === 'boolean')
    {
        lines.push(`${pad(0)}if value is not None:`);
        lines.push(`${pad(1)}value = bool(value)`);
    }
    else if (kind === 'array')
    {
        lines.push(`${pad(0)}if value is not None:`);
        lines.push(`${pad(1)}if not isinstance(value, list):`);
        lines.push(`${pad(2)}value = None`);

        if (memberDef.maxItems !== undefined)
        {
            lines.push(`${pad(1)}elif len(value) > ${memberDef.maxItems}:`);
            lines.push(`${pad(2)}value = value[:${memberDef.maxItems}]`);
        }
        if (memberDef.minItems !== undefined)
        {
            lines.push(`${pad(1)}if value is not None and len(value) < ${memberDef.minItems}:`);
            lines.push(`${pad(2)}value = None`);
        }
    }
    else if (kind === 'enum')
    {
        const enumName = parsedDatatype.enumName;
        lines.push(`${pad(0)}if value is not None:`);
        lines.push(`${pad(1)}valid_values = list(${enumName})`);
        lines.push(`${pad(1)}if value not in valid_values:`);
        lines.push(`${pad(2)}value = valid_values[0] if valid_values else None`);
    }
    else if (kind === 'date')
    {
        lines.push(`${pad(0)}if value is not None:`);
        lines.push(`${pad(1)}if isinstance(value, str):`);
        lines.push(`${pad(2)}try:`);
        lines.push(`${pad(3)}value = datetime.fromisoformat(value)`);
        lines.push(`${pad(2)}except ValueError:`);
        lines.push(`${pad(3)}value = datetime.now()`);
        lines.push(`${pad(1)}elif not isinstance(value, datetime):`);
        lines.push(`${pad(2)}value = datetime.now()`);
        lines.push(`${pad(0)}else:`);
        lines.push(`${pad(1)}value = datetime.now()`);
    }
    else if (kind === 'bytes')
    {
        lines.push(`${pad(0)}if value is not None:`);
        lines.push(`${pad(1)}if isinstance(value, str):`);
        lines.push(`${pad(2)}try:`);
        lines.push(`${pad(3)}import base64`);
        lines.push(`${pad(3)}value = base64.b64decode(value)`);
        lines.push(`${pad(2)}except Exception:`);
        lines.push(`${pad(3)}value = b''`);
        lines.push(`${pad(1)}elif not isinstance(value, bytes):`);
        lines.push(`${pad(2)}value = b''`);
        lines.push(`${pad(0)}else:`);
        lines.push(`${pad(1)}value = b''`);
    }

    return lines;
}

// ─── Python Class Generation ──────────────────────────────────────────────────

function generatePythonClass(classDef, inheritedMemberEntries)
{
    const { name, members } = classDef;
    const parentDef = classDef.extends || null;
    const memberEntries = Object.entries(members);
    const controlledMembers = memberEntries.filter(([, memberDef]) => isAccessControlled(memberDef));

    // Combine own + inherited members for import resolution (type hints apply to all constructor params)
    const allMembersForImports = {};
    for (const [mName, mDef] of inheritedMemberEntries) allMembersForImports[mName] = mDef;
    for (const [mName, mDef] of Object.entries(members)) allMembersForImports[mName] = mDef;

    const allEntries = [...inheritedMemberEntries, ...memberEntries];

    const needsAnyHint = allEntries.some(([, memberDef]) => !memberDef.datatype);
    const needsListHint = hasParameterizedArray(allMembersForImports);
    const needsReModule = memberEntries.some(([, memberDef]) =>
    {
        const parsed = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
        return parsed && parsed.kind === 'string' && memberDef.pattern;
    });
    const needsDatetimeImport = allEntries.some(([, memberDef]) =>
    {
        const parsed = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
        return parsed && parsed.kind === 'date';
    });
    const needsBytesImport = allEntries.some(([, memberDef]) =>
    {
        const parsed = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
        return parsed && parsed.kind === 'bytes';
    });
    const classHasIdMembers = hasIdMembers(members);
    const enumNames = collectEnumNamesFromMembers(allMembersForImports);
    const classRefs = collectClassRefsFromMembers(allMembersForImports);

    let output = '';

    // Imports
    if (classHasIdMembers)
    {
        output += `import uuid\n`;
    }

    if (needsReModule)
    {
        output += `import re\n`;
    }

    if (needsDatetimeImport)
    {
        output += `from datetime import datetime\n`;
    }

    if (needsBytesImport)
    {
        output += `import base64\n`;
    }

    const typingImports = [];
    if (needsAnyHint) typingImports.push('Any');
    if (needsListHint) typingImports.push('List');
    if (typingImports.length > 0)
    {
        output += `from typing import ${typingImports.join(', ')}\n`;
    }

    if (parentDef)
    {
        const parentModulePath = computePythonParentImportPath(parentDef.relativePath, parentDef.name);
        output += `from ${parentModulePath} import ${parentDef.name}\n`;
    }

    for (const enumName of enumNames)
    {
        output += `from Globals.Enumerations.${enumName} import ${enumName}\n`;
    }

    for (const [refClassName, refRelativePath] of classRefs)
    {
        if (refClassName === name) continue;

        if (refRelativePath)
        {
            const modulePath = computePythonParentImportPath(refRelativePath, refClassName);
            output += `from ${modulePath} import ${refClassName}\n`;
        }
    }

    const manualImports = Array.isArray(classDef.imports) ? classDef.imports : [];

    for (const importGroup of manualImports)
    {
        const modulePath = computePythonParentImportPath(importGroup.relativePath, '')
            .replace(/\.$/, '');
        // Python has no default imports; combine default + entities into one from…import
        const allEntitiesForImport = [
            ...(importGroup.default ? [importGroup.default] : []),
            ...(Array.isArray(importGroup.entities) ? importGroup.entities : [])
        ];
        output += `from ${modulePath} import ${allEntitiesForImport.join(', ')}\n`;
    }

    if (classHasIdMembers || needsReModule || needsDatetimeImport || needsBytesImport || typingImports.length > 0 || parentDef || enumNames.size > 0 || classRefs.size > 0 || manualImports.length > 0)
    {
        output += '\n';
    }

    output += '\n';

    const classDeclaration = parentDef
        ? `class ${name}(${parentDef.name}):`
        : `class ${name}:`;

    output += `${classDeclaration}\n`;

    // Constructor — inherited non-id params come first, then own non-id params.
    // super().__init__() receives inherited params as keyword arguments.
    const inheritedNonIdEntries = inheritedMemberEntries.filter(([, memberDef]) => memberDef.id !== true);
    const ownNonIdEntries = memberEntries.filter(([, memberDef]) => memberDef.id !== true);
    const allNonIdEntries = [...inheritedNonIdEntries, ...ownNonIdEntries];

    const constructorParamList = allNonIdEntries
        .map(([memberName, memberDef]) =>
        {
            const snakeName = toSnakeCase(memberName);
            const parsedDatatype = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
            const typeHint = getPythonTypeHint(parsedDatatype, name);
            const defaultValue = getPythonLiteralForDefault(memberDef);
            return `${snakeName}: ${typeHint} = ${defaultValue}`;
        })
        .join(', ');

    const constructorSignature = constructorParamList.length > 0
        ? `self, ${constructorParamList}`
        : 'self';

    output += `${indentation(1)}def __init__(${constructorSignature}) -> None:\n`;

    if (parentDef)
    {
        if (inheritedNonIdEntries.length > 0)
        {
            const superArgList = inheritedNonIdEntries
                .map(([memberName]) =>
                {
                    const snakeName = toSnakeCase(memberName);
                    return `${snakeName}=${snakeName}`;
                })
                .join(', ');
            output += `${indentation(2)}super().__init__(${superArgList})\n`;
        }
        else
        {
            output += `${indentation(2)}super().__init__()\n`;
        }
    }

    // Only handle OWN members in the constructor body — inherited members are handled by super()
    for (const [memberName, memberDef] of memberEntries)
    {
        const snakeName = toSnakeCase(memberName);
        const access = memberDef.access || 'private';
        const isId = memberDef.id === true;
        const isConstant = memberDef.constant === true;
        const isControlled = access === 'private' || access === 'protected';

        if (isId)
        {
            const backingField = isControlled
                ? getPythonBackingFieldName(memberName, memberDef)
                : `self.${snakeName}`;
            const target = isControlled ? `self.${backingField}` : backingField;
            output += `${indentation(2)}${target} = str(uuid.uuid4())\n`;
        }
        else if (access === 'public')
        {
            output += `${indentation(2)}self.${snakeName} = ${snakeName}\n`;
        }
        else if (isConstant)
        {
            output += `${indentation(2)}self.${getPythonBackingFieldName(memberName, memberDef)} = ${snakeName}\n`;
        }
        else
        {
            output += `${indentation(2)}self.set_${snakeName}(${snakeName})\n`;
        }
    }

    // Getters and setters for access-controlled members
    for (const [memberName, memberDef] of controlledMembers)
    {
        const snakeName = toSnakeCase(memberName);
        const backingField = getPythonBackingFieldName(memberName, memberDef);
        const parsedDatatype = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
        const typeHint = getPythonTypeHint(parsedDatatype, name);
        const isId = memberDef.id === true;
        const isConstant = memberDef.constant === true;

        output += '\n';

        output += `${indentation(1)}def get_${snakeName}(self) -> ${typeHint}:\n`;
        output += `${indentation(2)}return self.${backingField}\n`;

        // No setter for id or constant members
        if (!isId && !isConstant)
        {
            output += '\n';
            output += `${indentation(1)}def set_${snakeName}(self, value: ${typeHint}) -> None:\n`;

            const setterBodyLines = buildPythonSetterLines(memberDef, parsedDatatype, 2);

            if (setterBodyLines.length > 0)
            {
                output += setterBodyLines.join('\n') + '\n';
            }

            output += `${indentation(2)}self.${backingField} = value\n`;
        }
    }

    // Internal id-restore methods for OWN private/protected id fields only.
    // Parent classes define their own _restore_id methods which are inherited.
    const ownIdEntries = memberEntries.filter(([, memberDef]) => memberDef.id === true);

    for (const [memberName, memberDef] of ownIdEntries)
    {
        const snakeName = toSnakeCase(memberName);
        const access = memberDef.access || 'private';
        const isControlled = access === 'private' || access === 'protected';

        if (isControlled)
        {
            const backingField = getPythonBackingFieldName(memberName, memberDef);
            output += '\n';
            output += `${indentation(1)}def _restore_id_${snakeName}(self, stored_id):\n`;
            output += `${indentation(2)}if stored_id is not None:\n`;
            output += `${indentation(3)}self.${backingField} = stored_id\n`;
        }
    }

    // to_json — own members only; parent members are included via super().to_json()
    output += '\n';
    output += `${indentation(1)}def to_json(self) -> dict:\n`;
    output += `${indentation(2)}return {\n`;

    if (parentDef)
    {
        output += `${indentation(3)}**super().to_json(),\n`;
    }

    for (const [memberName, memberDef] of memberEntries)
    {
        const parsedDatatype = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
        const valueExpr = buildPythonToJsonExpression(memberName, memberDef, parsedDatatype);
        output += `${indentation(3)}'${memberName}': ${valueExpr},\n`;
    }

    output += `${indentation(2)}}\n`;

    // from_json — classmethod that reconstructs ALL fields (inherited + own) including stored ids
    output += '\n';
    output += `${indentation(1)}@classmethod\n`;
    output += `${indentation(1)}def from_json(cls, data: dict) -> '${name}':\n`;
    output += `${indentation(2)}instance = cls(\n`;

    const allFromJsonLines = allNonIdEntries.map(([memberName, memberDef]) =>
    {
        const snakeName = toSnakeCase(memberName);
        const parsedDatatype = memberDef.datatype ? parseDatatypeString(memberDef.datatype) : null;
        const valueExpr = buildPythonFromJsonExpression(memberName, memberDef, parsedDatatype);
        return `${indentation(3)}${snakeName}=${valueExpr}`;
    });

    output += allFromJsonLines.join(',\n') + '\n';
    output += `${indentation(2)})\n`;

    // Restore ALL id fields from the entire hierarchy (inherited + own).
    // Parent _restore_id methods are available through inheritance.
    const inheritedIdEntries = inheritedMemberEntries.filter(([, memberDef]) => memberDef.id === true);
    const allIdEntries = [...inheritedIdEntries, ...ownIdEntries];

    for (const [memberName, memberDef] of allIdEntries)
    {
        const snakeName = toSnakeCase(memberName);
        const access = memberDef.access || 'private';
        const isControlled = access === 'private' || access === 'protected';
        const storedValue = `data.get('${memberName}')`;

        if (isControlled)
        {
            output += `${indentation(2)}if ${storedValue} is not None:\n`;
            output += `${indentation(3)}instance._restore_id_${snakeName}(${storedValue})\n`;
        }
        else
        {
            output += `${indentation(2)}if ${storedValue} is not None:\n`;
            output += `${indentation(3)}instance.${snakeName} = ${storedValue}\n`;
        }
    }

    output += `${indentation(2)}return instance\n`;

    return output;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

function run()
{
    if (!fs.existsSync(serviceManifestPath))
    {
        console.error('Error: ServiceManifest.json not found. Run GenerateServiceManifest.js first.');
        process.exit(1);
    }

    if (!fs.existsSync(classesDirectory))
    {
        console.error(`Error: Classes directory not found: ${classesDirectory}`);
        process.exit(1);
    }

    const serviceManifest = JSON.parse(fs.readFileSync(serviceManifestPath, 'utf8'));
    const classFiles = fs.readdirSync(classesDirectory).filter(file => file.endsWith('.json'));

    if (classFiles.length === 0)
    {
        console.log('No class definition files found in Common/Classes/');
        return;
    }

    const classDefMap = loadClassDefinitionMap();

    let totalGenerated = 0;
    let totalSkipped = 0;

    for (const classFile of classFiles)
    {
        const classFilePath = path.join(classesDirectory, classFile);
        let classDef;

        try
        {
            classDef = JSON.parse(fs.readFileSync(classFilePath, 'utf8'));
        }
        catch (parseError)
        {
            console.error(`[SKIP] "${classFile}": invalid JSON — ${parseError.message}`);
            totalSkipped++;
            continue;
        }

        const validationErrors = validateClassDefinition(classDef, classFile);

        if (validationErrors.length > 0)
        {
            console.error(`[SKIP] "${classFile}" has validation errors:`);

            for (const validationError of validationErrors)
            {
                console.error(`       - ${validationError}`);
            }

            totalSkipped++;
            continue;
        }

        console.log(`\n[${classDef.name}]`);
        let serviceCount = 0;

        const inheritedMemberEntries = getInheritedMemberEntries(classDef, classDefMap);

        const targetServices = Array.isArray(classDef.services)
            ? new Set(classDef.services)
            : null;

        for (const [serviceName, serviceInfo] of Object.entries(serviceManifest))
        {
            if (targetServices !== null && !targetServices.has(serviceName))
            {
                continue;
            }

            const language = serviceInfo.language;
            let generatedCode;
            let outputFileName;

            if (language === 'javascript' || language === 'html5')
            {
                generatedCode = generateJsClass(classDef, language, inheritedMemberEntries);
                outputFileName = `${classDef.name}.js`;
            }
            else if (language === 'python')
            {
                generatedCode = generatePythonClass(classDef, inheritedMemberEntries);
                outputFileName = `${classDef.name}.py`;
            }
            else
            {
                console.warn(`  [WARN] Service "${serviceName}" has unsupported language "${language}", skipping.`);
                continue;
            }

            const outputDirectory = path.join(rootDirectory, serviceName, classDef.relativePath);
            const outputFilePath = path.join(outputDirectory, outputFileName);

            fs.mkdirSync(outputDirectory, { recursive: true });
            fs.writeFileSync(outputFilePath, generatedCode, 'utf8');

            console.log(`  -> ${path.relative(rootDirectory, outputFilePath)}`);
            serviceCount++;
            totalGenerated++;
        }

        console.log(`  Generated for ${serviceCount} service(s).`);
    }

    console.log(`\nDone. ${totalGenerated} file(s) generated, ${totalSkipped} definition(s) skipped.`);
}

run();