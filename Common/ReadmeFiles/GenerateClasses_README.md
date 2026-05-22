# GenerateClasses.js

Reads JSON class definitions from `Common/Classes/` and generates language-appropriate class files for every service registered in `ServiceManifest.json`.

## Usage

```
node Common/Scripts/GenerateClasses.js
```

Run `GenerateServiceManifest.js` first so that `ServiceManifest.json` is up to date.

---

## File Placement

| Path | Purpose |
|------|---------|
| `Common/Classes/<n>.json` | One JSON file per class definition |
| `<ServiceName>/<relativePath>/<n>.js` | Output for JavaScript / HTML5 services |
| `<ServiceName>/<relativePath>/<n>.py` | Output for Python services |

---

## Class Definition Format

```json
{
  "name": "TaskDescriptor",
  "relativePath": "Globals/Model",
  "services": ["Dock", "Worker"],
  "extends": { ... },
  "members": { ... }
}
```

### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | ✅ | PascalCase class name (e.g. `"TaskDescriptor"`) |
| `relativePath` | `string` | ✅ | Path inside each service root where the file is written (e.g. `"Globals/Model"`) |
| `members` | `object` | ✅ | Map of member name → member definition (at least one required) |
| `services` | `string[]` | — | Restrict generation to specific services. If omitted, the class is generated for **all** services in the manifest |
| `extends` | `object` | — | Parent class to inherit from. See **Inheritance** section |

---

## Service Filtering (`services`)

By default a class definition is generated for every service in `ServiceManifest.json`. Use `services` to target a subset.

```json
{
  "name": "DockPayload",
  "relativePath": "Globals/Model",
  "services": ["Dock", "Worker"],
  "members": { ... }
}
```

- The array must contain at least one entry.
- Each entry must exactly match a service directory name (PascalCase, same as the folder name).
- Services listed that do not appear in the manifest are silently skipped (they are simply not iterated).
- Omitting `services` entirely is equivalent to listing every service — no change in behaviour.

---

## Inheritance (`extends`)

Use the optional `extends` field to declare a parent class. The script automatically adds the import and generates the correct class declaration.

```json
{
  "name": "AutoGenerationSettings",
  "relativePath": "Globals/Model",
  "extends": {
    "name": "TaskSettings",
    "relativePath": "Globals/Model"
  },
  "members": { ... }
}
```

### `extends` Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | ✅ | PascalCase name of the parent class |
| `relativePath` | `string` | ✅ | Relative path inside the service root where the parent class lives |

### Generated output per language

**JavaScript (CommonJS)**
```js
const TaskSettings = require('./TaskSettings');

class AutoGenerationSettings extends TaskSettings
{
    constructor(...)
    {
        super();
        ...
    }
}
```

**JavaScript (HTML5)**
```js
import TaskSettings from './TaskSettings.js';

class AutoGenerationSettings extends TaskSettings
{
    constructor(...) { super(); ... }
}
```

**Python**
```python
from Globals.Model.TaskSettings import TaskSettings

class AutoGenerationSettings(TaskSettings):
    def __init__(self, ...) -> None:
        super().__init__()
        ...
```

The JS import path is computed as a relative path from the child's `relativePath` to the parent's. The Python import is always an absolute dot-separated path from the service root.

`members` on the child class defines only the **new** members introduced by that class — inherited members are not repeated.

---

## Member Definition

```json
"priority": {
  "datatype": "int",
  "access": "private",
  "defaultValue": 1,
  "constant": false,
  "min": 1,
  "max": 5
}
```

### Base Member Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `datatype` | `string` | — | See **Datatypes** below. Omit for untyped (`Any` in Python, no annotation in JS) |
| `access` | `string` | `"private"` | One of: `public`, `private`, `protected` |
| `defaultValue` | any | `null` / `None` | Constructor parameter default. Not allowed on `id` fields |
| `constant` | `boolean` | `false` | If `true`, no setter is generated and the value is fixed at construction. Cannot combine with `id` |
| `id` | `boolean` | `false` | If `true`, the field is auto-generated via UUID. No setter, excluded from constructor params. See **Auto-generated IDs** |
| `classRelativePath` | `string` | — | Required when `datatype` is `class:<n>` or `array<class:<n>>`. Path inside the service root where that class lives |

---

## Datatypes

### Basic Types

| Datatype | JS type | Python type |
|----------|---------|-------------|
| `int` | Number (integer) | `int` |
| `float` | Number (float) | `float` |
| `string` | String | `str` |
| `boolean` | Boolean | `bool` |
| `object` | Object | `dict` |
| `array` | Array | `list` |

### Enum Type — `enum:<EnumName>`

References an enumeration defined in `Common/Enumerations/`.

```json
"difficulty": {
  "datatype": "enum:DifficultyLevel",
  "access": "private",
  "defaultValue": 2
}
```

`defaultValue` for an enum member should be the **raw integer value** of the desired member (e.g. `2` for `MEDIUM`). The setter validates against the enum's values and snaps to the first member on an invalid input.

**Generated imports:**

| Language | Import |
|----------|--------|
| JS CommonJS | `const DifficultyLevel = require('../Enumerations/DifficultyLevel');` |
| JS HTML5 | `import DifficultyLevel from '../Enumerations/DifficultyLevel.js';` |
| Python | `from Globals.Enumerations.DifficultyLevel import DifficultyLevel` |

### Class Reference Type — `class:<ClassName>`

References another generated class. Requires `classRelativePath` on the same member to locate the file.

```json
"settings": {
  "datatype": "class:AutoGenerationSettings",
  "access": "private",
  "classRelativePath": "Globals/Model"
}
```

**Generated imports:**

| Language | Import |
|----------|--------|
| JS CommonJS | `const AutoGenerationSettings = require('../path/AutoGenerationSettings');` |
| JS HTML5 | `import AutoGenerationSettings from '../path/AutoGenerationSettings.js';` |
| Python | `from Globals.Model.AutoGenerationSettings import AutoGenerationSettings` |

The JS import path is computed as a relative path from the child class's `relativePath` to the `classRelativePath` of the referenced class. If `classRelativePath` is omitted, no import is emitted.

**Serialization:** `toJson` calls `.toJson()` / `.to_json()` on the nested instance. `fromJson` calls `ClassName.fromJson(…)` / `ClassName.from_json(…)` to reconstruct it.

### Typed Array — `array<type>`

Declares an array with a known element type. The inner type can be any basic type, an enum, or a class reference.

```json
"answers":    { "datatype": "array<string>" },
"types":      { "datatype": "array<enum:QuestionTypes>" },
"subTasks":   { "datatype": "array<class:SubTask>", "classRelativePath": "Globals/Model" }
```

The type parameter affects Python type hints (`List[str]`, `List[QuestionTypes]`, `List[SubTask]`) and serialization. Array constraints (`minItems`, `maxItems`) apply regardless of element type.

---

## Type-Specific Constraints

Constraints are flat fields on the member object alongside `datatype`, `access`, etc.

### `int` and `float`

| Constraint | Type | Behaviour |
|------------|------|-----------|
| `min` | `number` | Value clamped up to this (inclusive) |
| `max` | `number` | Value clamped down to this (inclusive) |

Non-numeric input is coerced. If coercion fails, falls back to `defaultValue`.

### `string`

| Constraint | Type | Behaviour |
|------------|------|-----------|
| `trim` | `boolean` | Strip leading/trailing whitespace before all other checks |
| `maxLength` | `integer ≥ 0` | Strings longer than this are truncated |
| `minLength` | `integer ≥ 0` | Strings shorter than this are set to `null`/`None` |
| `pattern` | `string` (regex) | Non-matching strings are set to `null`/`None` |
| `allowedValues` | `string[]` | Non-matching values are replaced with `allowedValues[0]` |

Order of operations: coerce → trim → maxLength → minLength → pattern → allowedValues.

### `boolean`

No constraints. Non-null input is coerced with `Boolean()` / `bool()`.

### `object`

No constraints. Stored as-is.

### `array` / `array<type>`

| Constraint | Type | Behaviour |
|------------|------|-----------|
| `minItems` | `integer ≥ 0` | Arrays shorter than this are set to `null`/`None` |
| `maxItems` | `integer ≥ 0` | Arrays longer than this are sliced |

Non-array input is set to `null`/`None`.

### `enum:<n>` and `class:<n>`

No additional constraints. Enum values are validated against enum members. Class references are stored as-is.

---

## Auto-generated IDs (`id: true`)

Mark any member with `"id": true` to have its value auto-generated via UUID at construction time.

```json
"recordId": {
  "datatype": "string",
  "access": "private",
  "id": true
}
```

| Rule | Detail |
|------|--------|
| Excluded from constructor params | Always auto-generated, never user-supplied |
| No setter | Value is immutable after construction |
| Cannot combine with `constant` | Both imply read-only but serve different purposes |
| Cannot have `defaultValue` | Value is always generated |
| Works with any `access` level | `private`, `protected`, and `public` all work |

**Round-trip:** `toJson` includes the id. `fromJson` / `from_json` restores the original id so deserialized objects keep the same id they were serialized with.

---

## Serialization

Every generated class includes `toJson` / `to_json` and `fromJson` / `from_json` automatically.

### `toJson()` / `to_json()`

Instance method returning a plain object / dict of all members.

| Type | Serialized as |
|------|--------------|
| `enum:<n>` (Python) | `.value` — raw integer |
| `array<enum:<n>>` (Python) | `[item.value …]` — list of integers |
| `class:<n>` | `.toJson()` / `.to_json()` — nested plain object |
| `array<class:<n>>` | `[item.toJson() …]` / `[item.to_json() …]` |
| All other types | Value as-is |

JSON keys are always the original camelCase member names from the definition file, ensuring cross-language wire format compatibility.

```js
// JavaScript
const serialized = JSON.stringify(instance.toJson());
```
```python
# Python
import json
serialized = json.dumps(instance.to_json())
```

### `fromJson(json)` / `from_json(data)`

Static / classmethod factory that reconstructs an instance from a plain object or dict.

| Type | Deserialized as |
|------|----------------|
| `enum:<n>` (Python) | `EnumName(value)` — reconstructed from integer |
| `array<enum:<n>>` (Python) | `[EnumName(v) …]` |
| `class:<n>` | `ClassName.fromJson(value)` / `ClassName.from_json(value)` |
| `array<class:<n>>` | `[ClassName.fromJson(item) …]` / `[ClassName.from_json(v) …]` |
| `id` field | Restored from stored value; fresh UUID generated if key is missing |
| All other types | Passed directly to the constructor (constraints applied via setters) |

```js
// JavaScript
const instance = MyClass.fromJson(JSON.parse(serialized));
```
```python
# Python
instance = MyClass.from_json(json.loads(serialized))
```

---

## Access Levels and Generated Code

| Access | JS backing field | JS accessors | Python backing field | Python accessors |
|--------|-----------------|-------------|---------------------|-----------------|
| `private` | `#field` | `getField()`, `setField(value)` | `__field` | `get_field()`, `set_field(value)` |
| `protected` | `_field` | `getField()`, `setField(value)` | `_field` | `get_field()`, `set_field(value)` |
| `public` | `this.field` (direct) | none | `self.field` (direct) | none |

The constructor always calls `setField()` / `set_field()` for non-constant, non-id, access-controlled members so all constraints are applied at construction time.

---

## Language Notes

### JavaScript
- CommonJS (`language: "javascript"`): `module.exports = ClassName`
- HTML5 (`language: "html5"`): `export default ClassName`
- No type annotations
- Semicolons throughout
- Private fields use native `#field` syntax (Node 12+ / modern browsers)
- `crypto` is imported via `require('crypto')` for CommonJS when `id` members are present; `crypto.randomUUID()` is a browser global for HTML5

### Python
- `import uuid` added only when `id` members are present
- `import re` added only when `pattern` constraints are used
- `from typing import Any` added only when members have no `datatype`
- `from typing import List` added only when `array<type>` members are present
- Member names are converted to `snake_case` for all Python identifiers
- Type annotations on all constructor parameters and method signatures

---

## Complete Example

### `Common/Classes/Question.json`

```json
{
  "name": "Question",
  "relativePath": "Globals/Model",
  "services": ["QuizService", "ReviewService"],
  "members": {
    "questionId": {
      "datatype": "string",
      "access": "private",
      "id": true
    },
    "questionType": {
      "datatype": "enum:QuestionTypes",
      "access": "private",
      "defaultValue": 0
    },
    "bodyText": {
      "datatype": "string",
      "access": "private",
      "minLength": 1,
      "maxLength": 500,
      "trim": true
    },
    "difficulty": {
      "datatype": "enum:DifficultyLevel",
      "access": "private",
      "defaultValue": 2
    },
    "answerOptions": {
      "datatype": "array<string>",
      "access": "private",
      "minItems": 2,
      "maxItems": 6
    },
    "metadata": {
      "datatype": "class:QuestionMetadata",
      "access": "private",
      "classRelativePath": "Globals/Model"
    },
    "tags": {
      "datatype": "array<enum:QuestionTypes>",
      "access": "public"
    },
    "schemaVersion": {
      "datatype": "string",
      "access": "private",
      "constant": true,
      "defaultValue": "2.0"
    }
  }
}
```

This definition will only generate files for `QuizService` and `ReviewService`, skipping all other services in the manifest.

---

## Validation Errors

Definitions with errors are skipped entirely; all other definitions continue processing.

| Error | Cause |
|-------|-------|
| `"name" must be PascalCase` | Name starts lowercase or contains invalid characters |
| `"relativePath" is required` | Missing or non-string path |
| `"services" must be an array` | `services` was set to a non-array value |
| `"services" must contain at least one entry` | Empty `services` array |
| `every entry in "services" must be a non-empty string` | A service name entry is not a string |
| `"extends" must be a plain object` | `extends` is not an object |
| `"extends.name" must be PascalCase` | Parent class name is invalid |
| `"extends.relativePath" is required` | Parent path is missing or not a string |
| `"extends" has unknown key "xyz"` | Only `name` and `relativePath` are allowed on `extends` |
| `unsupported datatype "xyz"` | Datatype not in the supported list |
| `enum name "xyz" must be PascalCase` | `enum:xyz` — the enum name is not PascalCase |
| `class name "xyz" must be PascalCase` | `class:xyz` — the class name is not PascalCase |
| `invalid array element type "xyz"` | `array<xyz>` — the inner type is not recognised |
| `unknown property "xyz" for datatype "int"` | Constraint not valid for the given datatype |
| `"min" cannot exceed "max"` | Numeric constraint range is inverted |
| `"minLength" cannot exceed "maxLength"` | String length range is inverted |
| `"minItems" cannot exceed "maxItems"` | Array item count range is inverted |
| `"id" and "constant" cannot both be true` | Both flags set on the same member |
| `"id" fields cannot have a "defaultValue"` | `id` members are always auto-generated |
| `"id" must be a boolean` | `id` was set to a non-boolean value |
| `member "x" must be a plain object` | Member definition is not a JSON object |
| `"members" must contain at least one entry` | Empty members object |
