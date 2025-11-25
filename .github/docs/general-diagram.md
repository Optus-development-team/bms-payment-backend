graph TD
    %% --- ACTORES ---
    User([Cliente])
    Admin([Dueño / Admin])
    
    %% --- PLATAFORMAS EXTERNAS ---
    WABiz[WhatsApp Business API]
    GCal[Google Calendar API]
    BankWeb[Web del Banco]
    BlockChain[Blockchain USDT/TRC20]

    %% --- SERVIDOR PRINCIPAL (EL CEREBRO) ---
    subgraph "Servidor Principal (NestJS - Agentes)"
        WebhookEntry[Webhook Controller]
        Security[Security Guard / RBAC]
        Orchestrator{Orquestador}
        
        subgraph "Logic Layer"
            AgentCitas[Agente Citas]
            AgentVentas[Agente Ventas]
            AgentReportes[Agente Reportes]
        end
        
        subgraph "Data Layer"
            LocalDB[(Base de Datos SQL Principal)]
            SyncService[Sync Calendar Service]
        end
    end

    %% --- SERVIDOR DE PAGOS (EL MICROSERVICIO) ---
    subgraph "Backend de Pagos (Aislado)"
        PaymentAPI[API Controller & Auth]
        
        subgraph "Módulo Fiat (Playwright)"
            PlaywrightInstance[Playwright Singleton]
            SessionStore[Shared Browser Context / Cookies]
            
            PlaywrightInstance --- SessionStore
        end
        
        subgraph "Módulo Cripto"
            CryptoWatcher[Blockchain Listener]
        end
        
        PaymentQueue[(Cola Redis)]
    end

    %% --- FLUJOS GENERALES ---
    User & Admin -->|Mensaje| WABiz
    WABiz -->|HTTP Post| WebhookEntry
    WebhookEntry --> Security
    Security -->|Valida Rol| Orchestrator

    Orchestrator -->|Intención: Cita| AgentCitas
    Orchestrator -->|Intención: Compra| AgentVentas
    Orchestrator -->|Intención: Info| AgentReportes

    %% --- GESTIÓN DE CITAS ---
    AgentCitas <--> LocalDB
    AgentCitas -.-> SyncService
    SyncService <--> GCal

    %% --- GESTIÓN DE PAGOS (FLUJO DETALLADO) ---
    
    %% FASE 1: GENERACIÓN QR
    AgentVentas -->|1. POST /generate-qr| PaymentAPI
    PaymentAPI -->|2. Job: GenQR| PaymentQueue
    PaymentQueue -->|3. Pop Job| PlaywrightInstance
    PlaywrightInstance -->|4. Usa Sesión Activa & Scrape QR| BankWeb
    PlaywrightInstance -->|5. Webhook: QR Image| WebhookEntry
    
    %% INTERACCIÓN USUARIO (Feedback Loop)
    WebhookEntry -.->|Pasa Imagen| AgentVentas
    AgentVentas -->|6. Envía QR| User
    User -->|7. Confirma 'Ya Pagué'| WABiz

    %% FASE 2: VERIFICACIÓN
    AgentVentas -->|8. POST /verify-payment| PaymentAPI
    PaymentAPI -->|9. Job: VerifyPayment| PaymentQueue
    PaymentQueue -->|10. Pop Job| PlaywrightInstance
    PlaywrightInstance -->|11. Reusa Misma Sesión & Scrape Historial| BankWeb
    PlaywrightInstance -->|12. Webhook: Success/Fail| WebhookEntry

    %% --- MANEJO DE 2FA (HUMAN-IN-THE-LOOP) ---
    %% Si Playwright detecta 2FA y no tiene código:
    PlaywrightInstance -.->|Excepción: 2FA Requerido| WebhookEntry
    WebhookEntry -.->|Alerta al Agente| AgentVentas
    AgentVentas -.->|Solicita Token 2FA| Admin
    Admin -.->|Responde Token| WABiz
    AgentVentas -.->|POST /v1/fiat/set-2fa| PaymentAPI
    PaymentAPI -.->|Actualiza Contexto & Reintenta| PlaywrightInstance

    %% --- FLUJO CRIPTO ---
    PaymentQueue -->|Job: WatchAddress| CryptoWatcher
    CryptoWatcher <--> BlockChain
    CryptoWatcher -->|Webhook: Success| WebhookEntry

    %% --- REPORTES ---
    AgentReportes -->|Read Only| LocalDB

    %% --- ESTILOS ---
    classDef external fill:#e1e1e1,stroke:#333;
    classDef mainServer fill:#d4f1f4,stroke:#05445e,stroke-width:2px;
    classDef payServer fill:#ffe2e2,stroke:#900,stroke-width:4px;
    classDef storage fill:#ffebbb,stroke:#333;
    
    class User,Admin,WABiz,GCal,BankWeb,BlockChain external;
    class WebhookEntry,Security,Orchestrator,AgentCitas,AgentVentas,AgentReportes,SyncService mainServer;
    class PaymentAPI,PlaywrightInstance,SessionStore,CryptoWatcher,PaymentQueue payServer;
    class LocalDB,PaymentQueue storage;