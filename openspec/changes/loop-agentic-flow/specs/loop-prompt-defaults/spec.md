## ADDED Requirements

### Requirement: Set de 7 prompts globales editables
La app SHALL mantener 7 prompts default editables por el usuario, almacenados en `<app-config>/prompts/`:

1. `problem-intake.md` — system prompt del Paso 1 (chat de refinamiento)
2. `phase-decomposition.md` — system prompt del Paso 2 (generación de fases + dependsOn + decisión de visual sí/no)
3. `analysis.md` — agente análisis del Paso 3
4. `implementation.md` — agente implementación del Paso 3
5. `review.md` — agente revisor del Paso 3
6. `knowledge.md` — agente conocimiento del Paso 3
7. `integration.md` — agente integrador del modo híbrido

#### Scenario: Primera instalación
- **WHEN** la app se abre por primera vez y `<app-config>/prompts/` no existe
- **THEN** el sistema crea el directorio
- **AND** copia los 7 archivos bundled con la app como semillas iniciales

#### Scenario: Recuperación de un archivo borrado
- **WHEN** el usuario borra manualmente uno de los archivos default (ej. `analysis.md`)
- **AND** la app arranca
- **THEN** el sistema detecta el archivo faltante y restaura la semilla bundled
- **AND** notifica "se restauró el prompt default de análisis"

### Requirement: Copia atómica al crear run
Al crear un run nuevo, el sistema SHALL copiar atómicamente los 7 prompts globales a `<run>/prompts/`. Esa copia es el contrato del run — futuras ediciones a los globales NO afectan runs ya creados, y ediciones a la copia del run no se propagan a los globales.

#### Scenario: Creación de run con prompts globales actuales
- **WHEN** el usuario inicia un nuevo run desde el Paso 1
- **THEN** el sistema crea `<run>/prompts/` y copia los 7 archivos globales adentro
- **AND** todas las invocaciones del run pasan los prompts del run, no los globales

#### Scenario: Edición global durante run activo
- **WHEN** un run está corriendo y el usuario edita el global `analysis.md`
- **THEN** el run en curso no se ve afectado (sigue usando su copia)
- **AND** un run nuevo creado después de la edición sí hereda el global actualizado

### Requirement: Edición inline desde el setup del Paso 3
El setup del Paso 3 SHALL exponer una vista unificada con sidebar de los 7 prompts y editor en el panel principal. Cada prompt MUST poder editarse en línea para el run, y el panel MUST exponer dos botones por prompt: **"↑ resetear a global"** (reemplaza el del run por el global actual) y **"↓ guardar como default global"** (pisa el global con el del run).

#### Scenario: Edición temporal para el run
- **WHEN** el usuario selecciona "análisis" en el sidebar y edita el textarea
- **AND** apreta "ejecutar run" sin tocar los botones de sync
- **THEN** el run usa el prompt editado
- **AND** el global de `analysis.md` no cambia
- **AND** el sidebar muestra el badge "modificado" en esa fila

#### Scenario: Promover edición a global
- **WHEN** el usuario edita un prompt y apreta "↓ guardar como default global"
- **THEN** el archivo global correspondiente en `<app-config>/prompts/` se sobrescribe con el contenido del run
- **AND** el badge cambia de "modificado" a "default"

#### Scenario: Resetear a global
- **WHEN** el usuario apreta "↑ resetear a global" sobre un prompt modificado
- **THEN** el prompt del run se reemplaza con el contenido actual del global
- **AND** el badge cambia de "modificado" a "default"

### Requirement: Indicador visual de divergencia vs global
El sidebar de prompts del setup SHALL mostrar por cada prompt un badge **"default"** (idéntico al global actual) o **"modificado"** (diverge del global). El badge MUST recalcularse cada vez que el usuario edita el prompt o sincroniza con global.

#### Scenario: Estado inicial al crear el run
- **WHEN** el usuario crea un run nuevo y abre el setup del Paso 3
- **THEN** los 7 prompts muestran badge "default" (porque acaban de copiarse del global)
