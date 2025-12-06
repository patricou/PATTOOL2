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
    console.log('[DiscussionService] connectWebSocket - Called with discussionId:', discussionId);
    console.log('[DiscussionService] connectWebSocket - Current state - connected:', this.connected, 'currentDiscussionId:', this.currentDiscussionId);
    
    if (this.connected && this.currentDiscussionId === discussionId) {
      console.log('[DiscussionService] connectWebSocket - Already connected to this discussion, emitting Connected status');
      // Already connected, but emit status so component knows it's connected
      this.messageSubject.next({ action: 'status', status: 'Connected', discussionId: discussionId });
      return; // Already connected to this discussion
    }

    // Disconnect previous connection if exists
    if (this.stompClient) {
      console.log('[DiscussionService] connectWebSocket - Disconnecting previous connection');
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

    console.log('[DiscussionService] connectWebSocket - WebSocket URL:', wsUrl);
    console.log('[DiscussionService] connectWebSocket - baseUrl:', baseUrl);
    console.log('[DiscussionService] connectWebSocket - environment.API_URL:', environment.API_URL);
    console.log('[DiscussionService] connectWebSocket - environment.production:', environment.production);
    
    try {
      console.log('[DiscussionService] connectWebSocket - Creating SockJS connection');
      this.socket = new SockJS(wsUrl);
      
      // Add socket event listeners for debugging
      this.socket.onopen = () => {
        console.log('[DiscussionService] connectWebSocket - SockJS connection opened');
      };
      
      this.socket.onclose = (event: any) => {
        console.log('[DiscussionService] connectWebSocket - SockJS connection closed', event);
      };
      
      this.socket.onerror = (error: any) => {
        console.error('[DiscussionService] connectWebSocket - SockJS error:', error);
      };
      
      const StompClient = getStompClient();
      
      console.log('[DiscussionService] connectWebSocket - Creating STOMP client');
      this.stompClient = new StompClient({
        webSocketFactory: () => this.socket,
        debug: (str: string) => {
          // Only log important messages to reduce console noise
          if (str.includes('ERROR') || str.includes('Connected') || str.includes('timeout') || str.includes('reconnection')) {
            console.log('[DiscussionService] STOMP:', str);
          }
        },
        reconnectDelay: 5000,
        heartbeatIncoming: 4000,
        heartbeatOutgoing: 4000,
        connectionTimeout: 20000, // Increased to 20 seconds for slower connections
      });

      this.stompClient.onConnect = (frame: any) => {
        console.log('[DiscussionService] connectWebSocket - WebSocket connected successfully', frame);
        this.connected = true;
        this.currentDiscussionId = discussionId;

        // Emit connection status update
        console.log('[DiscussionService] connectWebSocket - Emitting Connected status');
        this.messageSubject.next({ action: 'status', status: 'Connected', discussionId: discussionId });

        // Subscribe to discussion updates
        const topic = '/topic/discussion/' + discussionId;
        console.log('[DiscussionService] connectWebSocket - Subscribing to topic:', topic);
        this.stompClient.subscribe(topic, (message: any) => {
          console.log('[DiscussionService] connectWebSocket - Received message via WebSocket:', message);
          try {
            const data = JSON.parse(message.body);
            console.log('[DiscussionService] connectWebSocket - Parsed message data:', data);
            this.messageSubject.next(data);
          } catch (error) {
            console.error('[DiscussionService] connectWebSocket - Error parsing WebSocket message:', error);
          }
        });
        console.log('[DiscussionService] connectWebSocket - Subscribed to', topic);
      };

      this.stompClient.onStompError = (frame: any) => {
        console.error('WebSocket STOMP error:', frame);
        const currentId = this.currentDiscussionId;
        this.connected = false;
        this.currentDiscussionId = null;
        const errorMessage = frame.headers?.['message'] || 'Connection error';
        this.messageSubject.next({ action: 'status', status: `Connection error: ${errorMessage}`, discussionId: currentId });
      };

      this.stompClient.onWebSocketError = (event: any) => {
        console.error('WebSocket error:', event);
        const currentId = this.currentDiscussionId;
        this.connected = false;
        this.currentDiscussionId = null;
        this.messageSubject.next({ action: 'status', status: 'Connection error', discussionId: currentId });
      };

      this.stompClient.onWebSocketClose = (event: any) => {
        console.log('WebSocket closed:', event);
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
          console.warn('WebSocket connection timeout - connection may have failed');
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
      console.log('[DiscussionService] connectWebSocket - Activating STOMP client');
      this.stompClient.activate();
      console.log('[DiscussionService] connectWebSocket - WebSocket activation initiated');
    } catch (error) {
      console.error('[DiscussionService] connectWebSocket - Error creating WebSocket connection:', error);
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

