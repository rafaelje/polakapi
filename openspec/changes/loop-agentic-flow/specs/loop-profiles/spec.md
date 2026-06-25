## ADDED Requirements

### Requirement: Almacenamiento global de perfiles en JSON
Los perfiles SHALL persistirse en `profiles.json` en el config dir de la app (vía `tauri-plugin-store`), siguiendo el mismo patrón que `workspaces.json`. El archivo MUST tener `schemaVersion` y un array `profiles[]`. Cada perfil contiene `id`, `name`, `createdAt`, y una `matrix` con los 5 agentes (`analysis`, `implementation`, `review`, `knowledge`, `integration`), cada uno con `{ cli, model }`.

#### Scenario: Primera carga sin perfiles
- **WHEN** la app se abre por primera vez y no existe `profiles.json`
- **THEN** el sistema crea uno con `{ schemaVersion: 1, profiles: [] }`
- **AND** la UI muestra "sin perfiles guardados"

#### Scenario: Schema version incompatible
- **WHEN** existe `profiles.json` con un `schemaVersion` desconocido
- **THEN** el sistema lo trata como vacío (silent fallback, igual que `workspaces-store.ts`)
- **AND** preserva el archivo original sin sobrescribir

### Requirement: Default sin perfil cargado
Cuando ningún perfil está cargado en el setup del Paso 3, todos los slots de la matriz SHALL arrancar con `claude / opus-4-7`. El usuario puede editar cada slot manualmente desde ese punto.

#### Scenario: Setup inicial sin perfil
- **WHEN** el usuario llega al setup del Paso 3 y no selecciona perfil del dropdown
- **THEN** los 5 agentes muestran `claude / opus-4-7`
- **AND** los badges de cada slot indican "default" (no "modificado")

### Requirement: Overrides temporales sobre perfil cargado
Cuando el usuario carga un perfil y modifica algún slot, los cambios SHALL aplicar sólo al run en curso. Para persistir, el sistema MUST exponer botones explícitos: "guardar" (pisa el perfil cargado) o "guardar como…" (crea uno nuevo).

#### Scenario: Override aplica al run sin persistir
- **WHEN** el usuario carga el perfil "mi mixto" y cambia el revisor de codex a claude/sonnet
- **AND** apreta "ejecutar run" sin tocar "guardar"
- **THEN** el run usa claude/sonnet para el revisor
- **AND** "mi mixto" en `profiles.json` permanece con codex

#### Scenario: Guardar como nuevo
- **WHEN** el usuario con un perfil cargado modifica slots y elige "guardar como…"
- **THEN** se le pide un nombre y se crea un perfil nuevo en `profiles.json`
- **AND** el perfil original no cambia

### Requirement: Validación de disponibilidad al cargar
Al cargar un perfil, el sistema SHALL validar que cada CLI esté instalado (en PATH) y que el modelo configurado esté disponible. Si alguno falla, el slot correspondiente MUST marcarse en rojo en la UI, sin sugerir fallbacks automáticos. El usuario MUST elegir manualmente otro CLI/modelo antes de poder ejecutar el run.

#### Scenario: CLI no instalado
- **WHEN** se carga un perfil cuyo agente de análisis está configurado con `opencode` y `opencode` no está en PATH
- **THEN** el slot del agente de análisis se marca en rojo con texto "opencode no encontrado"
- **AND** el botón "ejecutar run" queda deshabilitado hasta que el usuario corrija

#### Scenario: Modelo inexistente
- **WHEN** un perfil referencia un modelo deprecado (ej. `haiku-4-5` en claude 2.1.187 que devuelve 404)
- **THEN** el sistema marca el slot en rojo con "modelo no disponible"
- **AND** el usuario elige otro modelo del dropdown manualmente
