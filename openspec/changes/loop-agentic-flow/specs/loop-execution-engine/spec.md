## ADDED Requirements

### Requirement: Selección de modo de ejecución
El Paso 3 SHALL ofrecer dos modos: **secuencial** (una fase a la vez con knowledge propagado) y **híbrido** (batches por sort topológico con integrador entre cada uno). El modo MUST seleccionarse antes de arrancar el run.

#### Scenario: Modo híbrido no disponible
- **WHEN** todas las fases dependen linealmente unas de otras (sort topológico produce N batches de 1)
- **THEN** el selector permite elegir híbrido pero la UI advierte "equivalente a secuencial · sin paralelismo"

### Requirement: Pipeline de agentes en modo secuencial
En modo secuencial, por cada fase el sistema SHALL ejecutar agentes en este orden: **análisis → implementación → revisor → conocimiento**. Cada agente MUST esperar el output del anterior. La fase siguiente SHALL recibir el `knowledge.md` de la fase anterior como input adicional.

#### Scenario: Fase aprobada al primer intento
- **WHEN** el revisor devuelve `ok` en el primer intento
- **THEN** el knowledge agent corre con todos los outputs (analysis + implementation + review)
- **AND** el sistema avanza a la fase siguiente con el `knowledge.md` producido

### Requirement: Cap de reintentos del revisor
El revisor SHALL aprobar o solicitar retry. Si devuelve `retry+feedback`, el sistema MUST relanzar la implementación con el feedback adjuntado. El cap es **3 intentos**. Al alcanzar 3 sin aprobación, la fase MUST quedar marcada con estado `warning` (⚠) y el sistema SHALL continuar al agente de conocimiento con el último intento.

#### Scenario: Aprobado en intento 2
- **WHEN** el revisor pide retry en intento 1 y aprueba en intento 2
- **THEN** la fase queda en estado `done` (sin warning)
- **AND** el contador de retries se persiste en `state.json`

#### Scenario: Cap alcanzado
- **WHEN** el revisor pide retry en los 3 intentos
- **THEN** la fase queda en estado `warning`
- **AND** el agente de conocimiento corre igual con el último output de implementación
- **AND** el `knowledge.md` MUST mencionar explícitamente la deuda en la sección "Warnings"

### Requirement: Modo híbrido por batches
En modo híbrido, el sistema SHALL agrupar fases en batches por sort topológico (fases sin dependencias pendientes corren en paralelo). Dentro de un batch, las fases SHALL correr sus pipelines de agentes (análisis → impl → revisor → conocimiento) sin compartir knowledge entre ellas. Entre batches, un agente integrador MUST consolidar los knowledge individuales y validar que no haya conflictos de FS.

#### Scenario: Dos batches con integrador entre
- **WHEN** el sort topológico produce batch 1 = [01, 04] y batch 2 = [02, 03, 05] dependiendo de [01, 04]
- **THEN** el sistema corre las pipelines de 01 y 04 en paralelo
- **AND** al terminar ambos, ejecuta el integrador batch 1
- **AND** el integrador produce un `knowledge.md` consolidado en `outputs/batches/batch-1/knowledge.md`
- **AND** ese consolidado se pasa como input adicional a las fases 02, 03, 05

#### Scenario: Conflicto de FS detectado por el integrador
- **WHEN** dos fases del mismo batch tocaron el mismo archivo con cambios incompatibles
- **THEN** el integrador reporta el conflicto en su output
- **AND** el run pausa esperando decisión del usuario (continuar / abortar / re-ejecutar fase)

#### Scenario: Fase ⚠ en batch propaga warning
- **WHEN** la fase 04 termina en estado warning dentro del batch 1
- **THEN** el integrador del batch 1 lo anota en el knowledge consolidado
- **AND** las fases del batch 2 reciben ese knowledge con la nota de la deuda

### Requirement: Invocación de agentes vía CLI configurado
Cada agente SHALL ejecutarse invocando el CLI configurado (claude/codex/opencode) con su modelo correspondiente vía el comando Tauri `run_loop_agent`. La invocación MUST ser one-shot y devolver un `AgentResult` normalizado con `text`, `tokens_in`, `tokens_out`, `cost_usd`, `session_id`, y `error`. Cada invocación MUST respetar un timeout configurable (default 300s).

#### Scenario: Invocación exitosa de claude
- **WHEN** el agente de análisis está configurado como `claude / opus-4-7`
- **THEN** el sistema invoca `claude -p <prompt> --model opus-4-7 --output-format json --append-system-prompt-file <prompts/analysis.md>`
- **AND** parsea el JSON resultado y normaliza a `AgentResult`

#### Scenario: Timeout en una invocación
- **WHEN** una invocación de agente excede el timeout configurado
- **THEN** el subproceso es matado
- **AND** el agente reporta `error: "timeout"` y la fase entra en flujo de retry (si aplica)

#### Scenario: CLI no disponible en PATH
- **WHEN** el CLI configurado no es ejecutable
- **THEN** la invocación falla rápido con error "cli not found"
- **AND** el usuario es notificado antes de gastar tokens en agentes subsecuentes

### Requirement: Persistencia de estado y resume
Cada run SHALL persistir su estado en `<run>/state.json` con granularidad por agente, incluyendo el batch actual (modo híbrido), el agente en curso por fase, el contador de retries, y un `lastHeartbeat`. Al abrir `/loop` sobre un project que tiene un run con `status: "running"` y heartbeat viejo, el sistema MUST detectarlo y ofrecer retomar.

#### Scenario: Resume después de crash
- **WHEN** la app crashea durante un run y el usuario reabre `/loop` sobre el mismo project
- **THEN** el sistema lee `state.json` y muestra "run interrumpido detectado · ¿retomar?"
- **AND** al confirmar, el scheduler reanuda desde la última tarea incompleta
- **AND** si un agente quedó a medias (output parcial), su trabajo se descarta y se relanza desde cero

#### Scenario: Heartbeat actualizado
- **WHEN** un agente está corriendo
- **THEN** el run actualiza `lastHeartbeat` en `state.json` cada N segundos
- **AND** si pasan más de N×3 segundos sin actualizar, se asume crash

### Requirement: Budget visible en vivo
La vista de ejecución SHALL mostrar el costo en USD y los tokens consumidos acumulados, desglosados por agente. Cuando el run supera el budget configurado, el sistema MUST pausar antes de la siguiente invocación y pedir confirmación.

#### Scenario: Budget excedido
- **WHEN** el costo acumulado supera el budget configurado del run
- **THEN** el scheduler pausa antes del próximo agente
- **AND** muestra "budget excedido · continuar / abortar"
