import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';
import { Observable, from, Subject, of } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';

// WebSocket imports - using dynamic require to avoid build-time issues
const getSockJS = () => {
  const SockJSModule = require('sockjs-client');
  return SockJSModule.default || SockJSModule;
};

const getStompClient = () => {
  const StompModule = require('@stomp/stompjs');
  // @stomp/stompjs exports Client as the default or named export
  return StompModule.Client || StompModule.default || StompModule;
};

export interface Discussion {
  id?: string;
  createdBy?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    userName?: string;
  };
  creationDate?: Date;
  title?: string;
  messages?: DiscussionMessage[];
}

export interface DiscussionMessage {
  id?: string;
  author?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    userName?: string;
  };
  dateTime?: Date;
  message?: string;
  imageUrl?: string;
  videoUrl?: string;
  imageFileName?: string;
  videoFileName?: string;
}

@Injectable()
export class DiscussionService {
  private API_URL: string = environment.API_URL;
  private stompClient: any = null;
  private messageSubject = new Subject<any>();
  private connected = false;
  private currentDiscussionId: string | null = null;
  private socket: any = null;

  constructor(
    private _http: HttpClient,
    private _keycloakService: KeycloakService
  ) {}

  // Get the header with token for Keycloak Security
  private getHeaderWithToken(): Observable<HttpHeaders> {
    return from(this._keycloakService.getToken()).pipe(
      map((token: string) => {
        return new HttpHeaders({
          'Accept': 'application/json',
          'Content-Type': 'application/json; charset=UTF-8',
          'Authorization': 'Bearer ' + token
        });
      })
    );
  }

  // Get headers for multipart/form-data (file uploads)
  private getMultipartHeaderWithToken(): Observable<HttpHeaders> {
    return from(this._keycloakService.getToken()).pipe(
      map((token: string) => {
        return new HttpHeaders({
          'Authorization': 'Bearer ' + token
          // Don't set Content-Type for multipart - browser will set it with boundary
        });
      })
    );
  }

  /**
   * Get all discussions
   */
  getAllDiscussions(): Observable<Discussion[]> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<Discussion[]>(this.API_URL + 'discussions', { headers: headers })
      )
    );
  }

  /**
   * Get a discussion by ID
   */
  getDiscussionById(id: string): Observable<Discussion> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<Discussion>(this.API_URL + 'discussions/' + id, { headers: headers })
      )
    );
  }

  /**
   * Get the default discussion (Discussion Generale)
   */
  getDefaultDiscussion(): Observable<Discussion> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<Discussion>(this.API_URL + 'discussions/default', { headers: headers })
      )
    );
  }

  /**
   * Create a new discussion
   */
  createDiscussion(title?: string): Observable<Discussion> {
    const formData = new FormData();
    if (title) {
      formData.append('title', title);
    }

    return this.getMultipartHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post<Discussion>(this.API_URL + 'discussions', formData, { headers: headers })
      )
    );
  }

  /**
   * Get or create a discussion by ID
   * If the discussion exists, return it. Otherwise, create a new one with the given title.
   */
  getOrCreateDiscussion(discussionId: string | null | undefined, title?: string): Observable<Discussion> {
    // If no discussionId provided, create a new discussion
    if (!discussionId) {
      return this.createDiscussion(title);
    }

    // Try to get the discussion by ID
    return this.getDiscussionById(discussionId).pipe(
      // If discussion exists, return it
      catchError((error: any) => {
        if (error.status === 404) {
          // Discussion not found, create a new one
          return this.createDiscussion(title);
        }
        // Re-throw other errors
        throw error;
      })
    );
  }

  /**
   * Get all messages for a discussion
   */
  getMessages(discussionId: string): Observable<DiscussionMessage[]> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<DiscussionMessage[]>(this.API_URL + 'discussions/' + discussionId + '/messages', { headers: headers })
      )
    );
  }

  /**
   * Add a message to a discussion
   */
  addMessage(
    discussionId: string,
    message: string,
    image?: File,
    video?: File
  ): Observable<DiscussionMessage> {
    const formData = new FormData();
    formData.append('message', message);
    if (image) {
      formData.append('image', image);
    }
    if (video) {
      formData.append('video', video);
    }

    return this.getMultipartHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post<DiscussionMessage>(
          this.API_URL + 'discussions/' + discussionId + '/messages',
          formData,
          { headers: headers }
        )
      )
    );
  }

  /**
   * Update a message in a discussion
   */
  updateMessage(discussionId: string, messageId: string, message: string): Observable<DiscussionMessage> {
    const formData = new FormData();
    formData.append('message', message);

    return this.getMultipartHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<DiscussionMessage>(
          this.API_URL + 'discussions/' + discussionId + '/messages/' + messageId,
          formData,
          { headers: headers }
        )
      )
    );
  }

  /**
   * Delete a message from a discussion
   */
  deleteMessage(discussionId: string, messageId: string): Observable<void> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete<void>(
          this.API_URL + 'discussions/' + discussionId + '/messages/' + messageId,
          { headers: headers }
        )
      )
    );
  }

  /**
   * Connect to WebSocket for real-time updates
   */
  connectWebSocket(discussionId: string): void {
    if (this.connected && this.currentDiscussionId === discussionId) {
      // Already connected, but emit status so component knows it's connected
      this.messageSubject.next({ action: 'status', status: 'Connected', discussionId: discussionId });
      return; // Already connected to this discussion
    }

    // Disconnect previous connection if exists
    if (this.stompClient) {
      this.disconnectWebSocket();
    }

    // Determine WebSocket URL based on environment
    // Extract base URL from API_URL
    let baseUrl = '';
    if (!environment.production && environment.API_URL) {
      // Extract base URL from API_URL (e.g., "http://localhost:8000/api/" -> "http://localhost:8000")
      const match = environment.API_URL.match(/^(https?:\/\/[^\/]+)/);
      if (match) {
        baseUrl = match[1];
      }
    }
    const wsUrl = baseUrl ? `${baseUrl}/ws` : '/ws';

    // Lazy load SockJS and Stomp to avoid import issues
    const SockJS = getSockJS();
    const StompClient = getStompClient();
    
    try {
      this.socket = new SockJS(wsUrl);
      
      const StompClient = getStompClient();
      
      this.stompClient = new StompClient({
        webSocketFactory: () => this.socket,
        debug: (str: string) => {
          // Silent debug - no logging
        },
        reconnectDelay: 5000,
        heartbeatIncoming: 4000,
        heartbeatOutgoing: 4000,
        connectionTimeout: 20000, // Increased to 20 seconds for slower connections
      });

      this.stompClient.onConnect = (frame: any) => {
        this.connected = true;
        this.currentDiscussionId = discussionId;

        // Emit connection status update
        this.messageSubject.next({ action: 'status', status: 'Connected', discussionId: discussionId });

        // Subscribe to discussion updates
        const topic = '/topic/discussion/' + discussionId;
        this.stompClient.subscribe(topic, (message: any) => {
          try {
            const data = JSON.parse(message.body);
            this.messageSubject.next(data);
          } catch (error) {
            // Silent error handling
          }
        });
      };

      this.stompClient.onStompError = (frame: any) => {
        const currentId = this.currentDiscussionId;
        this.connected = false;
        this.currentDiscussionId = null;
        const errorMessage = frame.headers?.['message'] || 'Connection error';
        this.messageSubject.next({ action: 'status', status: `Connection error: ${errorMessage}`, discussionId: currentId });
      };

      this.stompClient.onWebSocketError = (event: any) => {
        const currentId = this.currentDiscussionId;
        this.connected = false;
        this.currentDiscussionId = null;
        this.messageSubject.next({ action: 'status', status: 'Connection error', discussionId: currentId });
      };

      this.stompClient.onWebSocketClose = (event: any) => {
        const currentId = this.currentDiscussionId;
        this.connected = false;
        this.currentDiscussionId = null;
        // Only emit disconnected status if it wasn't a clean close during reconnection
        if (!event.wasClean || event.code !== 1000) {
          this.messageSubject.next({ action: 'status', status: 'Disconnected', discussionId: currentId });
        }
      };

      // Set a timeout to detect if connection hangs and notify user
      let connectionTimeoutId: any = null;
      connectionTimeoutId = setTimeout(() => {
        if (!this.connected) {
          this.messageSubject.next({ action: 'status', status: 'Connection timeout - messages may not update in real-time', discussionId: discussionId });
        }
      }, 15000); // 15 second timeout

      // Clear timeout on successful connection
      const originalOnConnect = this.stompClient.onConnect;
      this.stompClient.onConnect = (frame: any) => {
        if (connectionTimeoutId) {
          clearTimeout(connectionTimeoutId);
          connectionTimeoutId = null;
        }
        if (originalOnConnect) {
          originalOnConnect(frame);
        }
      };

      // Activate the connection
      this.stompClient.activate();
    } catch (error) {
      this.connected = false;
      this.currentDiscussionId = null;
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnectWebSocket(): void {
    if (this.stompClient) {
      if (this.connected) {
        this.stompClient.deactivate();
      }
      this.connected = false;
      this.currentDiscussionId = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.stompClient = null;
  }

  /**
   * Get observable for real-time messages
   */
  getMessageObservable(): Observable<any> {
    return this.messageSubject.asObservable();
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get file URL for images/videos
   */
  getFileUrl(discussionId: string, subfolder: string, filename: string): string {
    const baseUrl = environment.production ? '' : 'http://localhost:8000';
    return `${baseUrl}/api/discussions/files/${discussionId}/${subfolder}/${filename}`;
  }
}

