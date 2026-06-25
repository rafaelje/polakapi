## ADDED Requirements

### Requirement: Generación inicial de fases desde 01-problem.md
El Paso 2 SHALL invocar al CLI configurado (con el system prompt `phase-decomposition.md`) pasando `01-problem.md` para producir una lista de fases. Cada fase MUST tener un identificador secuencial (`01`, `02`, ...), nombre, y al menos un archivo `logic.md`. El LLM SHALL decidir si la fase incluye además `visual.html`.

#### Scenario: Generación exitosa
- **WHEN** el usuario consolida el Paso 1 y entra al Paso 2 por primera vez
- **THEN** el sistema invoca el CLI con `01-problem.md` como input
- **AND** crea una carpeta por fase en `<run>/phases/<NN>-<slug>/`
- **AND** cada carpeta contiene `logic.md` (siempre) y `visual.html` (cuando el LLM lo marcó como necesario)

#### Scenario: Fase sin parte visual
- **WHEN** el LLM determina que una fase no tiene componente visual (ej. tarea de backend pura)
- **THEN** la carpeta de esa fase contiene sólo `logic.md`
- **AND** la UI no muestra el tab `visual.html` para esa fase

### Requirement: Declaración de dependencias entre fases
Cada fase SHALL tener un campo `dependsOn: [phaseId]`. El LLM propone valores iniciales; el usuario SHALL poder editarlos. Una fase con `dependsOn: []` es una raíz. El sistema MUST detectar ciclos y rechazarlos.

#### Scenario: LLM propone dependencias
- **WHEN** el LLM genera las fases iniciales
- **THEN** cada fase trae un `dependsOn[]` propuesto
- **AND** el sidebar muestra "↳ raíz" o "↳ depende de <pill>NN</pill>" debajo del nombre

#### Scenario: Usuario edita dependencias
- **WHEN** el usuario abre el editor de una fase y modifica `dependsOn`
- **THEN** la vista topología se recalcula al instante
- **AND** los batches en el modo híbrido se reordenan según el nuevo DAG

#### Scenario: Ciclo detectado
- **WHEN** el usuario intenta agregar una dependencia que crearía un ciclo (ej. 02 depende de 04 y 04 depende de 02)
- **THEN** el sistema rechaza el cambio y muestra "ciclo detectado entre 02 y 04"

### Requirement: Editor inline con sidebar de fases
El Paso 2 SHALL exponer un editor con sidebar de fases a la izquierda y tabs `logic.md` / `visual.html` a la derecha. El usuario MUST poder agregar, eliminar, renombrar y reordenar fases manualmente.

#### Scenario: Agregar fase manual
- **WHEN** el usuario presiona "+ agregar fase" en el sidebar
- **THEN** se crea una fase nueva con un nombre placeholder y `logic.md` vacío
- **AND** queda seleccionada para edición

#### Scenario: Eliminar fase con dependientes
- **WHEN** el usuario elimina una fase X y existe alguna fase Y con `X` en su `dependsOn`
- **THEN** el sistema pide confirmación
- **AND** al confirmar, remueve `X` del `dependsOn` de todas las fases dependientes

### Requirement: Edición asistida por AI
Cada archivo (`logic.md` o `visual.html`) SHALL exponer un botón "editar con AI" que abre un mini-chat sobre la selección actual y reemplaza esa sección por la edición propuesta cuando el usuario acepta.

#### Scenario: Edición con AI exitosa
- **WHEN** el usuario selecciona texto en `logic.md` y presiona "✨ editar con AI" con una instrucción ("hacelo más conciso")
- **THEN** el sistema invoca el CLI con la sección seleccionada y la instrucción
- **AND** muestra el diff propuesto
- **AND** al aceptar, reemplaza la sección por la edición

### Requirement: Vista de topología derivada del DAG
El Paso 2 SHALL incluir una vista "topología de ejecución" read-only que muestre los batches calculados a partir de los `dependsOn` de todas las fases. La vista MUST recalcularse al instante cuando cambian dependencias.

#### Scenario: Topología con dos batches
- **WHEN** las fases son 5 (01 raíz, 04 raíz, 02 depende de 01, 03 depende de 01, 05 depende de 04)
- **THEN** la vista muestra batch 1 = [01, 04], batch 2 = [02, 03, 05]
- **AND** el resumen indica "2 batches paralelos · modo paralelo posible"

#### Scenario: Topología totalmente lineal
- **WHEN** cada fase depende de la anterior
- **THEN** la vista muestra N batches con una fase cada uno
- **AND** el resumen indica "modo paralelo no aplica — equivalente a secuencial"
