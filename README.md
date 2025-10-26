# PATTOOL2 - Sportive Events Organization Platform

## Overview

**PATTOOL2** is a comprehensive full-stack web application that facilitates the creation, management, and organization of sportive events. The platform serves as a private social network for organizing activities with integrated features including AI-powered chat, IoT home automation controls, file management, and multi-language support.

### Architecture Overview
- **Frontend**: Angular 17 application (TypeScript/JavaScript)
- **Backend**: Spring Boot 3.3.0 REST API (Java 21)
- **Database**: MongoDB for data persistence
- **Real-time Communication**: Firebase Realtime Database
- **Authentication**: Keycloak SSO with JWT tokens
- **File Storage**: MongoDB GridFS and local disk storage

## Table of Contents

1. [Features](#features)
2. [Technology Stack](#technology-stack)
3. [System Architecture](#system-architecture)
4. [Frontend Implementation](#frontend-implementation)
5. [Backend Implementation](#backend-implementation)
6. [Key Components](#key-components)
7. [Security](#security)
8. [Development](#development)
9. [Production Deployment](#production-deployment)

---

## Features

### 1. **Events Management (`evenements`)**
- **Create & Organize Sports Events**: Users can create activities/events with detailed information
- **Event Details Include**:
  - Event name, description, and type
  - Start and end dates with time
  - Location and difficulty level
  - Duration estimation
  - Open and close inscription dates
  - Rating system (likes/dislikes)
  - Visibility settings (public/private)
- **Participants Management**: Track members who join events
- **File Uploads**: Attach multiple files (images, PDFs, documents) to events
- **Event Status Management**: Open, close, or cancel events
- **Comments System**: Users can comment on events
- **Live Chat**: Real-time chat functionality per event using Firebase
- **URL Links**: Attach external website links to events

### 2. **AI-Powered Chat (PatGPT)**
- Integration with AI chat service (similar to ChatGPT)
- Supports conversation history
- Configurable historical context (last X questions)
- Text-based query and response system
- Session management with historical data deletion

### 3. **Global Communication (Firebase Chat)**
- Real-time global chat room using Firebase Realtime Database
- Anonymous authentication through Firebase
- Message synchronization across all users
- Message sorting by timestamp (newest first)
- Delete messages functionality

### 4. **URL Links Management**
- Personal bookmark system
- Category-based organization
- Public/private visibility controls
- Admin interface for link management
- Filter by user-specific links

### 5. **IoT Home Automation**
- Automatic gate control (open/close)
- Ethernet shield connectivity testing
- Remote device control integration
- Arduino-compatible communication

### 6. **File Management**
- Drag-and-drop file upload
- Multiple file types supported (images, PDFs, documents)
- File uploads to both database and disk
- Image thumbnail generation
- PDF document viewing
- File download capabilities

### 7. **Multi-Language Support (i18n)**
- Support for 11 languages: Arabic, Chinese, German, Greek, English, Spanish, French, Hebrew, Italian, Japanese, Russian
- Dynamic language switching
- Localized content storage in JSON files
- Translation using `@ngx-translate/core`

---

## Technology Stack

### Frontend Framework
- **Angular 17.0.0**: Core framework
- **TypeScript 5.4.0**: Programming language
- **RxJS 7.8.0**: Reactive programming
- **Zone.js 0.14.0**: Change detection

### UI Libraries & Styles
- **Bootstrap 5.3.0**: UI framework
- **@ng-bootstrap/ng-bootstrap 16.0.0**: Angular Bootstrap components
- **jQuery 3.7.0**: DOM manipulation
- **ng2-file-upload 1.4.0**: File upload handling
- **ngx-mydatepicker 2.4.11**: Date picker component

### Authentication & Security
- **Keycloak**: SSO and authentication provider
- **JWT Tokens**: Bearer token authentication
- **HTTP Interceptors**: Automatic token injection
- **Role-based Access Control**: User roles management

### Communication & Database
- **Firebase 10.12.0**: Realtime Database for chat
- **@angular/fire 17.0.0**: Angular Firebase integration
- **REST API**: Backend communication (localhost:8000 in dev)

### Internationalization
- **@ngx-translate/core 15.0.0**: Translation framework
- **@ngx-translate/http-loader 8.0.0**: HTTP translation loader

### Development Tools
- **Angular CLI**: Project scaffolding and build
- **Karma**: Unit testing
- **Jasmine**: Testing framework
- **Protractor**: E2E testing

### Backend Framework
- **Spring Boot 3.3.0**: Java framework
- **Java 21**: Programming language
- **Spring Security**: Security framework
- **Spring Data MongoDB**: MongoDB integration
- **Maven**: Build tool and dependency management

### Backend Dependencies
- **spring-boot-starter-data-rest**: REST API support
- **spring-boot-starter-web**: Web framework
- **spring-boot-starter-oauth2-resource-server**: OAuth2 support
- **springdoc-openapi-starter-webmvc-ui 2.3.0**: Swagger/OpenAPI documentation
- **commons-io 2.16.1**: File I/O utilities
- **Guava 33.0.0**: Google libraries
- **spring-boot-starter-mail**: Email functionality
- **H2 Database**: In-memory database for testing

---

## System Architecture

### Project Structure

```
PATTOOL2/
├── PatTool_Front-End/         # Angular frontend application
│   ├── src/
│   │   ├── app/
│   │   │   ├── admin/              # Admin panel for link management
│   │   │   ├── communications/     # Firebase global chat module
│   │   │   ├── evenements/         # Events management module
│   │   │   │   ├── create-evenement/
│   │   │   │   ├── update-evenement/
│   │   │   │   ├── details-evenement/
│   │   │   │   └── element-evenement/
│   │   │   ├── home/               # Home page module
│   │   │   ├── iothome/            # IoT controls module
│   │   │   ├── keycloak/           # Keycloak authentication service
│   │   │   ├── links/              # URL links management module
│   │   │   ├── patgpt/             # AI chat module
│   │   │   ├── services/           # Business logic services
│   │   │   ├── model/              # Data models
│   │   │   └── shared/             # Shared components (navigation)
│   │   ├── assets/
│   │   │   ├── i18n/               # Translation files (11 languages)
│   │   │   ├── images/             # Static images
│   │   │   └── video/              # Video assets
│   │   ├── environments/           # Environment configuration
│   │   └── index.html
│   ├── package.json
│   └── angular.json
└── [Backend/API]                  # REST API backend (separate repository)
```

### Module Architecture

The application follows Angular's modular architecture with lazy-loaded feature modules:

1. **AppModule**: Root module with main routing and core services
2. **EvenementsModule**: Events CRUD operations
3. **HomeModule**: Landing page
4. **ChatModule**: Firebase communication
5. **LinksModule**: URL management
6. **PatgptModule**: AI chat interface
7. **MapsModule**: About page
8. **LinksAdminModule**: Admin interface
9. **NavigationButtonsModule**: Shared navigation

### Data Flow

```
User Action → Component → Service → HTTP Request → Backend API
                           ↓
                    Keycloak Token
                           ↓
                    HTTP Interceptor
                           ↓
                    REST API (localhost:8000)
                           ↓
                    Spring Security Filter
                           ↓
                    REST Controller → Service Layer → MongoDB
```

### Backend Structure

```
PatTool_Back-End/
├── src/main/
│   ├── java/com/pat/
│   │   ├── config/                    # Configuration classes
│   │   │   ├── SecurityConfig.java    # Spring Security configuration
│   │   │   ├── SwaggerConfig.java     # API documentation
│   │   │   ├── WebConfig.java         # Web configuration
│   │   │   └── GlobalExceptionHandler.java
│   │   ├── controller/               # REST Controllers
│   │   │   ├── EvenementRestController.java
│   │   │   ├── MemberRestController.java
│   │   │   ├── FileRestController.java
│   │   │   ├── ChatController.java
│   │   │   ├── UrlLinkRestController.java
│   │   │   ├── CategoryLinkRestController.java
│   │   │   ├── HomeIOTController.java
│   │   │   └── MailController.java
│   │   ├── repo/                     # MongoDB repositories
│   │   │   ├── EvenementsRepository.java
│   │   │   ├── MembersRepository.java
│   │   │   ├── UrlLinkRepository.java
│   │   │   └── ChatRequestRepository.java
│   │   ├── repo/domain/              # Entity models
│   │   │   ├── Evenement.java
│   │   │   ├── Member.java
│   │   │   ├── Commentary.java
│   │   │   ├── FileUploaded.java
│   │   │   ├── UrlEvent.java
│   │   │   └── ChatRequest.java
│   │   ├── service/                  # Business logic
│   │   │   ├── ChatService.java
│   │   │   ├── HomeIOTService.java
│   │   │   └── SmtpMailSender.java
│   │   └── PatToolApplication.java   # Main application class
│   └── resources/
│       └── application.properties    # Configuration
├── pom.xml                          # Maven dependencies
└── target/                          # Build output
```

---

## Key Components

### Services

1. **EvenementsService**: 
   - CRUD operations for events
   - Pagination support
   - User-specific filtering
   - Token-based authentication

2. **MembersService**:
   - User management
   - User ID retrieval from MongoDB
   - Role management

3. **PatgptService**:
   - AI chat interaction
   - Historical context management
   - Chat session handling

4. **FileService**:
   - File upload to disk
   - File metadata management

5. **UrllinkService**:
   - Link CRUD operations
   - Category management
   - Visibility controls

6. **IotService**:
   - IoT device control
   - Arduino communication

7. **KeycloakService**:
   - Authentication token management
   - User information extraction
   - Logout handling

8. **CommonvaluesService**:
   - Shared state management
   - Language persistence
   - Common configuration

### Models

- **Member**: User profile with roles and authentication info
- **Evenement**: Complete event data structure
- **Commentary**: Event comments
- **UploadedFile**: File metadata
- **UrlEvent**: External links attached to events
- **Category**: Link categorization
- **Urllink**: URL bookmark data
- **ChatResponse**: AI chat response structure

---

## Security

### Authentication Flow

1. **Keycloak SSO**: Users are redirected to Keycloak for login
2. **JWT Tokens**: Bearer tokens are obtained after authentication
3. **HTTP Interceptor**: Automatically adds `Authorization: Bearer <token>` to all requests
4. **Token Refresh**: Automatic token refresh when expiring (5-second buffer)
5. **Logout**: Centralized logout with Keycloak redirect

### Security Features

- **HTTPS Required**: Keycloak configured with SSL
- **Public Client**: Frontend-only authentication (no client secret)
- **Role-based Access**: User roles from Keycloak realm
- **Token Validation**: Server-side token verification
- **CORS Protection**: Backend enforces CORS policies

### Keycloak Configuration

```javascript
Realm: 'pat-realm'
Client ID: 'tutorial-frontend'
Auth Server URL: '/auth'
SSL Required: true
Public Client: true
```

---

## Frontend Implementation

### Routing Configuration

```typescript
Routes:
- / → HomePageComponent
- /even → HomeEvenementsComponent (Event listing)
- /neweven → CreateEvenementComponent
- /updeven/:id → UpdateEvenementComponent
- /details-evenement/:id → DetailsEvenementComponent
- /results → ChatComponent (Firebase global chat)
- /links → LinksComponent (Bookmarks)
- /links-admin → LinksAdminComponent
- /iot → IothomeComponent
- /patgpt → PatgptComponent
- /maps → AboutComponent
```

Uses **HashLocationStrategy** to support deep linking and page refreshes in production.

### Firestore Integration

- **Realtime Database**: Used for global chat messages
- **Anonymous Auth**: Firebase anonymous authentication for chat
- **Path**: `/globalMessages` in Firebase Realtime Database
- **Message Structure**: Includes timestamp, user, message content, priority

### File Upload Mechanism

1. **Drag & Drop Support**: Visual drag-over feedback
2. **Multiple Files**: Batch file selection
3. **Thumbnail Detection**: Automatically detects images for thumbnail generation
4. **Modified Filenames**: Adds "thumbnail" to image names
5. **Upload Endpoints**:
   - `/uploadfile`: Database storage
   - `/uploadondisk`: File system storage

### Multi-Language Implementation

- **Translation Loader**: HTTP-based lazy loading of translation files
- **Language Persistence**: Stored in service for session persistence
- **Default Language**: French (fr)
- **Supported Languages**: ar, cn, de, el, en, es, fr, he, it, jp, ru
- **Switchable Language Selector**: Draggable component in UI

### Event Data Model

```typescript
Evenement {
  author: Member              // Event creator
  openInscriptionDate: Date   // Registration opens
  closeInscriptionDate: Date  // Registration closes
  beginEventDate: Date        // Event starts
  endEventDate: Date          // Event ends
  creationDate: Date          // Event created
  evenementName: string       // Name
  comments: string            // Description
  type: string                // Event type
  status: string              // Open/Closed/Cancelled
  difficulty: string          // Difficulty level
  startLocation: string       // Meet location
  startHour: string           // Start time
  durationEstimation: string  // Estimated duration
  ratingPlus: number          // Likes
  ratingMinus: number         // Dislikes
  visibility: string          // Public/Private
  members: Member[]           // Participants
  fileUploadeds: UploadedFile[] // Attached files
  urlEvents: UrlEvent[]       // External links
  commentaries: Commentary[]  // User comments
}
```

---

## Backend Implementation

### REST Controllers

The backend exposes RESTful APIs through Spring Boot controllers:

#### 1. **EvenementRestController** (`/api/even`)
- `GET /{name}/{page}/{size}` - Paginated event list with user filtering
- `GET /{id}` - Get single event details
- `POST /` - Create new event
- `PUT /` - Update event
- `PUT /file` - Update event files
- `DELETE /{id}` - Delete event

#### 2. **MemberRestController** (`/api/memb`)
- User registration and management
- User ID retrieval from MongoDB
- Profile management

#### 3. **FileRestController** (`/uploadondisk`, `/uploadfile`)
- File upload to disk storage
- File upload to MongoDB GridFS
- File metadata management
- File download functionality

#### 4. **ChatController** (`/api/chat`)
- AI chat request processing
- Integration with OpenAI API
- Historical context management
- Session management (`/api/delchat/`)

#### 5. **UrlLinkRestController** (`/api/urllink`)
- CRUD operations for bookmarks
- Category management
- Visibility controls

#### 6. **CategoryLinkRestController** (`/api/categories`)
- Category CRUD operations
- Category-link associations

#### 7. **HomeIOTController** (`/api/opcl`, `/api/testarduino`)
- IoT device control (gate open/close)
- Arduino connectivity testing
- ESP32 device control

#### 8. **MailController**
- Email sending functionality
- SMTP integration

### Spring Security Configuration

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {
    // CORS configuration for cross-origin requests
    // All API endpoints are publicly accessible
    // Keycloak OAuth2 bearer token validation
    // Session management: STATELESS
}
```

**Security Features**:
- **CORS**: Configured for cross-origin requests
- **CSRF**: Disabled for API usage
- **OAuth2**: Bearer token validation through Keycloak
- **Public Endpoints**: Most API endpoints are publicly accessible
- **Swagger**: Public access to API documentation

### MongoDB Integration

- **Repository Pattern**: Spring Data MongoDB repositories
- **GridFS**: File storage in MongoDB
- **Collections**: Separate collections for events, members, files, chat requests
- **Indexing**: Optimized queries with proper indexing
- **Connection**: Host-based or URI-based connection

**Configuration** (`application.properties`):
```properties
spring.data.mongodb.host=192.168.1.33
spring.data.mongodb.port=27017
spring.data.mongodb.database=rando
```

### File Storage

Two storage mechanisms:

1. **MongoDB GridFS** (`/uploadfile`):
   - Binary file storage in MongoDB
   - Metadata tracking
   - GridFS template usage

2. **Local Disk Storage** (`/uploadondisk`):
   - Files stored on local filesystem
   - Configurable upload directory (`app.uploaddir=r:\\`)
   - Maximum file size: 100MB
   - Maximum request size: 350MB

### AI Chat Integration (PatGPT)

- **OpenAI API Integration**: Chat completion requests
- **Configuration** (`application.properties`):
  ```properties
  openai.api=https://api.openai.com/v1/chat/completions
  openai.key=sk-proj-...
  app.maxContextSize=10000
  ```
- **Historical Context**: Manages conversation history
- **Service Layer**: `ChatService` handles API communication

### Email Functionality

- **SMTP Configuration**: Uses custom mail server
- **Spring Mail**: `spring-boot-starter-mail`
- **Configuration** (`application.properties`):
  ```properties
  spring.mail.host=patrickdeschamps.com
  spring.mail.port=465
  spring.mail.username=mailuser
  spring.mail.password=***
  app.mailsentfrom=mailuser@patrickdeschamps.com
  ```

### API Documentation

- **Swagger/OpenAPI**: Auto-generated API documentation
- **Access**: `/swagger-ui/` and `/v3/api-docs/`
- **Library**: `springdoc-openapi-starter-webmvc-ui`
- **Public Access**: Available without authentication

### Application Configuration

**Server Configuration** (`application.properties`):
```properties
server.port=8000
spring.application.name=PATTOOL
app.uploaddir=r:\\

# File upload limits
spring.servlet.multipart.max-file-size=100MB
spring.servlet.multipart.max-request-size=350MB

# Keycloak configuration
keycloak.realm=pat-realm
keycloak.auth-server-url=http://localhost:8080/auth
keycloak.resource=tutorial-frontend
keycloak.bearer-only=true

# OpenAI configuration
openai.api=https://api.openai.com/v1/chat/completions
openai.key=sk-proj-...

# IoT configuration
app.arduino.ip=192.168.1.65
app.esp32.1.ip=192.168.1.71
```

### Dependency Management

Maven-based build system (`pom.xml`):

- **Parent**: Spring Boot 3.3.0
- **Java Version**: 21
- **Packaging**: JAR
- **Build Plugin**: spring-boot-maven-plugin
- **Compiler**: maven-compiler-plugin for Java 21

---

## Development

### Prerequisites

**Frontend Development**:
- **Node.js**: v20+
- **npm**: Latest version
- **Angular CLI**: v17.0.0

**Backend Development**:
- **Java 21**: JDK installation
- **Maven 3.6+**: Build tool
- **MongoDB**: Database server (local or remote)
- **IntelliJ IDEA**: Recommended IDE (or any Java IDE)

**Required Services**:
- **Keycloak Server**: v7+ running on `localhost:8080`
- **MongoDB**: Running on `localhost:27017` or remote server

### Installation

**Frontend Setup**:
```bash
# Clone the repository
git clone <repository-url>
cd PatTool_Front-End

# Install dependencies
npm install

# Verify Angular CLI
ng version
```

**Backend Setup**:
```bash
# Navigate to backend directory
cd PatTool_Back-End

# Build with Maven (downloads dependencies automatically)
mvn clean install

# Or just compile without running tests
mvn clean package -DskipTests
```

### Development Server

**Frontend**:
```bash
# Start Angular development server
cd PatTool_Front-End
ng serve

# Navigate to http://localhost:4200/
# App automatically reloads on file changes
```

**Backend**:
```bash
# Start Spring Boot application
cd PatTool_Back-End
mvn spring-boot:run

# Or run the JAR directly
java -jar target/pattool-0.0.1-SNAPSHOT.jar

# Application starts on http://localhost:8000/
# API documentation available at http://localhost:8000/swagger-ui/
```

### Environment Configuration

**Development** (`src/environments/environment.ts`):
```typescript
keykloakBaseUrl: 'http://localhost:8080/auth'
serviceBaseUrl: 'http://localhost:8080/database'
API_URL: 'http://localhost:8000/api/'
```

**Production** (`src/environments/environment.prod.ts`):
```typescript
keykloakBaseUrl: 'https://www.patrickdeschamps.com:8543/auth'
serviceBaseUrl: 'https://www.patrickdeschamps.com:8543/database'
API_URL: '/api/'
```

### Build

**Frontend**:
```bash
# Development build
ng build

# Production build
ng build --configuration production

# Output directory: dist/PatTool_Front-End/
```

**Backend**:
```bash
# Build JAR file
cd PatTool_Back-End
mvn clean package

# Output: target/pattool-0.0.1-SNAPSHOT.jar
```

### Testing

```bash
# Unit tests
ng test
# Uses Karma + Jasmine

# E2E tests
ng e2e
# Uses Protractor
```

### Code Generation

```bash
# Generate component
ng generate component component-name

# Generate service
ng generate service service-name

# Generate module
ng generate module module-name
```

---

## Production Deployment

### Frontend Deployment

**Build Artifacts**:
Production build creates optimized, minified bundle in `dist/PatTool_Front-End/`.

**Configuration**:
1. **Environment**: Switch to `environment.prod.ts` for production
2. **Base URL**: Uses relative paths (`/api/`) in production
3. **Keycloak**: Points to production server (`www.patrickdeschamps.com:8543`)
4. **HTTPS**: SSL enabled for security

**Deployment Steps**:
1. Build production bundle: `ng build --configuration production`
2. Configure web server (nginx/Apache) to serve `dist/PatTool_Front-End/`
3. Set up reverse proxy for API: `/api/*` → `localhost:8000`
4. Configure SSL certificates
5. Set up Keycloak realm and client in production
6. Configure Firebase project for realtime database
7. Test authentication flow
8. Verify file upload functionality

### Backend Deployment

**Build Artifacts**:
Production build creates executable JAR: `target/pattool-0.0.1-SNAPSHOT.jar`

**Configuration** (`application.properties`):

**Production MongoDB**:
```properties
# Use remote MongoDB (e.g., MLAB)
spring.data.mongodb.uri=mongodb://user:password@host:port/database

# Or local MongoDB
spring.data.mongodb.host=192.168.1.33
spring.data.mongodb.port=27017
spring.data.mongodb.database=rando
```

**SSL Configuration**:
```properties
server.ssl.key-store=tomcat.keystore
server.ssl.key-store-password=password
server.ssl.keyAlias=tomcat
```

**Production Upload Directory**:
```properties
app.uploaddir=/path/to/upload/directory
```

**Keycloak Configuration**:
```properties
keycloak.auth-server-url=https://www.patrickdeschamps.com:8543/auth
```

**Deployment Steps**:
1. Build JAR: `mvn clean package`
2. Copy JAR to server: `target/pattool-0.0.1-SNAPSHOT.jar`
3. Create systemd service or use `nohup` to run as background process
4. Configure MongoDB connection (remote or local)
5. Set up SSL certificates for HTTPS
6. Configure Keycloak production realm
7. Set up reverse proxy (nginx/Apache) for frontend
8. Test API endpoints
9. Verify file uploads work correctly
10. Monitor logs: `logs/spring.log`

### Keycloak Production Setup

Required Keycloak realm:
- **Realm Name**: `pat-realm`
- **Client ID**: `tutorial-frontend`
- **Redirect URIs**: `https://www.patrickdeschamps.com/*`
- **Web Origins**: `https://www.patrickdeschamps.com`

---

## API Endpoints

### Events API
- `GET /api/even/{name}/{page}/{size}` - List events (paginated)
- `GET /api/even/{id}` - Get event details
- `POST /api/even` - Create event
- `PUT /api/even` - Update event
- `PUT /api/file` - Update event files
- `DELETE /api/even/{id}` - Delete event

### File Upload API
- `POST /uploadfile` - Upload to database
- `POST /uploadondisk` - Upload to disk

### Chat API
- `POST /api/chat/{historical}/{lastx}` - Send AI chat message
- `DELETE /api/delchat/` - Clear chat history

### Links API
- `GET /api/urllink` - Get user's links
- `GET /api/categories` - Get categories
- `POST /api/urllink` - Create link
- `PUT /api/urllink/{id}` - Update link
- `DELETE /api/urllink/{id}` - Delete link
- `PUT /api/visibility/` - Update visibility

### IoT API
- `POST /api/opcl` - Open/Close gate
- `POST /api/testarduino` - Test Arduino connection

---

## Dependencies Summary

### Core Dependencies
- Angular 17 (Core, Forms, Router, HTTP Client)
- Bootstrap 5.3.0
- RxJS 7.8.0
- TypeScript 5.4.0

### UI & UX
- @ng-bootstrap/ng-bootstrap
- jQuery
- Font Awesome icons
- Material Icons

### Authentication
- Keycloak.js (custom)

### Communication
- Firebase SDK
- @angular/fire

### File Handling
- ng2-file-upload
- pdfjs-dist

### Date Handling
- ngx-mydatepicker

### Internationalization
- @ngx-translate/core
- @ngx-translate/http-loader

---

## Features Summary

✅ **User Management**: Keycloak SSO integration  
✅ **Events**: Full CRUD operations with rich metadata  
✅ **File Management**: Drag-and-drop uploads with thumbnails  
✅ **Real-time Chat**: Firebase global chat room  
✅ **AI Integration**: PatGPT chat assistant  
✅ **URL Management**: Personal bookmark system  
✅ **IoT Controls**: Home automation integration  
✅ **Multi-language**: 11 languages supported  
✅ **Responsive Design**: Bootstrap-based mobile-friendly UI  
✅ **Security**: JWT tokens, role-based access control  

---

## License

MIT License - See LICENSE file for details

---

## Author

**Patrick DESCHAMPS**  
Website: https://www.patrickdeschamps.com  
Email: Available through the application

---

## Additional Resources

- [Angular Documentation](https://angular.io/docs)
- [Keycloak Documentation](https://www.keycloak.org/documentation)
- [Firebase Documentation](https://firebase.google.com/docs)
- [Bootstrap Documentation](https://getbootstrap.com/docs)

