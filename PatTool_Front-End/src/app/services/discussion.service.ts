import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';
import { Observable, from, Subject, of } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';

export interface StreamedDiscussion {
  type: 'discussion' | 'complete' | 'error';
  data: DiscussionItem | null;
}

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

export interface DiscussionItem {
  id: string;
  title: string;
  type: 'general' | 'event' | 'friendGroup';
  discussion?: Discussion;
  event?: any; // Evenement type
  friendGroup?: any; // FriendGroup type
  messageCount?: number;
  lastMessageDate?: Date;
}

@Injectable()
export class DiscussionService {
  private API_URL: string = environment.API_URL;
  private stompClient: any = null;
  private messageSubject = new Subject<any>();
  private connected = false;
  private currentDiscussionId: string | null = null;
  private socket: any = null;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private tokenCache: string | null = null;
  private tokenCacheTime: number = 0;
  private readonly TOKEN_CACHE_DURATION = 60000; // 1 minute cache
  private activeSubscription: any = null; // Track active STOMP subscription

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
   * Get all accessible discussions for the current user
   * Returns discussions for events and friend groups the user can access
   * Backend validates and creates missing discussions automatically
   */
  getAccessibleDiscussions(): Observable<DiscussionItem[]> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<DiscussionItem[]>(this.API_URL + 'discussions/accessible', { headers: headers })
      )
    );
  }

  /**
   * Stream accessible discussions using Server-Sent Events (SSE)
   * Returns discussions one by one as they are processed (truly reactive)
   */
  streamAccessibleDiscussions(): Observable<StreamedDiscussion> {
    const subject = new Subject<StreamedDiscussion>();
    
    this.getHeaderWithToken().subscribe({
      next: (headers) => {
        const token = headers.get('Authorization') || '';
        const url = this.API_URL + 'discussions/accessible/stream';
        
        // Use fetch API since EventSource doesn't support custom headers
        this.streamDiscussionsWithFetch(url, token, subject).catch(err => {
          subject.error(err);
        });
      },
      error: (err) => {
        subject.error(err);
      }
    });
    
    return subject.asObservable();
  }

  private async streamDiscussionsWithFetch(
    url: string, 
    authToken: string, 
    subject: Subject<StreamedDiscussion>
  ): Promise<void> {
    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': authToken,
          'Accept': 'text/event-stream'
        },
        cache: 'no-cache'
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      if (!reader) {
        subject.error(new Error('No reader available'));
        return;
      }

      let currentEventType: string | null = null;
      let currentData: string = '';

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          // Process any remaining data
          if (currentEventType && currentData) {
            this.processSSEDiscussionEvent(currentEventType, currentData, subject);
          }
          subject.complete();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim() === '') {
            // Empty line indicates end of event - process it
            if (currentEventType && currentData) {
              this.processSSEDiscussionEvent(currentEventType, currentData, subject);
              currentEventType = null;
              currentData = '';
            }
            continue;
          }
          
          if (line.startsWith('event:')) {
            // Process previous event if exists
            if (currentEventType && currentData) {
              this.processSSEDiscussionEvent(currentEventType, currentData, subject);
            }
            currentEventType = line.substring(6).trim();
            currentData = '';
            continue;
          }
          
          if (line.startsWith('data:')) {
            const data = line.substring(5).trim();
            if (currentData) {
              currentData += '\n' + data; // Handle multi-line data
            } else {
              currentData = data;
            }
          }
        }
      }
    } catch (error) {
      subject.error(error);
    }
  }

  private processSSEDiscussionEvent(eventType: string, data: string, subject: Subject<StreamedDiscussion>): void {
    if (eventType === 'discussion') {
      try {
        const parsed = JSON.parse(data);
        subject.next({
          type: 'discussion',
          data: parsed
        });
      } catch (e) {
        console.error('Error parsing discussion data:', e);
        subject.next({
          type: 'error',
          data: null
        });
      }
    } else if (eventType === 'complete') {
      subject.next({
        type: 'complete',
        data: null
      });
    } else if (eventType === 'error') {
      subject.next({
        type: 'error',
        data: null
      });
    }
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
   * Delete a discussion
   */
  deleteDiscussion(discussionId: string): Observable<void> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete<void>(
          this.API_URL + 'discussions/' + discussionId,
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
      // Already connected to this discussion, but ensure subscription is active
      // Emit status so component knows it's connected
      this.messageSubject.next({ action: 'status', status: 'Connected', discussionId: discussionId });
      
      // Ensure subscription is active - if we don't have one, create it
      if (this.stompClient && this.stompClient.connected && !this.activeSubscription) {
        const topic = '/topic/discussion/' + discussionId;
        this.activeSubscription = this.stompClient.subscribe(topic, (message: any) => {
          try {
            const data = JSON.parse(message.body);
            this.messageSubject.next(data);
          } catch (error) {
            // Silent error handling
          }
        });
      }
      return; // Already connected to this discussion
    }

    // Disconnect previous connection if exists
    if (this.stompClient) {
      this.disconnectWebSocket();
    }

    // Emit "Connecting" status when starting a new connection
    this.messageSubject.next({ action: 'status', status: 'Connecting', discussionId: discussionId });

    // Get authentication token (use cache if available and recent)
    const now = Date.now();
    if (this.tokenCache && (now - this.tokenCacheTime) < this.TOKEN_CACHE_DURATION) {
      // Use cached token
      console.log('Using cached token for WebSocket connection');
      this.connectWebSocketWithToken(discussionId, this.tokenCache);
    } else {
      // Get fresh token asynchronously (non-blocking)
      // Use Promise to avoid blocking the browser
      this._keycloakService.getToken().then((token: string) => {
        if (token) {
          console.log('Token retrieved for WebSocket connection, length:', token.length);
          // Cache the token
          this.tokenCache = token;
          this.tokenCacheTime = Date.now();
          this.connectWebSocketWithToken(discussionId, token);
        } else {
          console.warn('Token is null, connecting without token');
          this.connectWebSocketWithToken(discussionId, null);
        }
      }).catch((error) => {
        console.warn('Could not get token for WebSocket connection, connecting without token', error);
        // Connect without token - backend will handle anonymous users
        this.connectWebSocketWithToken(discussionId, null);
      });
    }
  }

  /**
   * Internal method to connect with token
   */
  private connectWebSocketWithToken(discussionId: string, token: string | null): void {

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
    
    // Add token as query parameter for SockJS (since it doesn't support custom headers)
    let wsUrl = baseUrl ? `${baseUrl}/ws` : '/ws';
    if (token) {
      wsUrl += '?token=' + encodeURIComponent(token);
      console.log('WebSocket URL with token (length):', wsUrl.substring(0, 50) + '...');
    } else {
      console.warn('WebSocket connecting without token!');
    }

    // Lazy load SockJS and Stomp to avoid import issues
    const SockJS = getSockJS();
    const StompClient = getStompClient();
    
    try {
      this.socket = new SockJS(wsUrl);
      
      // Prepare connect headers with token
      const connectHeaders: any = {};
      if (token) {
        connectHeaders['Authorization'] = 'Bearer ' + token;
        console.log('STOMP connect headers include Authorization token');
      } else {
        console.warn('STOMP connect headers do NOT include Authorization token!');
      }
      
      this.stompClient = new StompClient({
        webSocketFactory: () => this.socket,
        connectHeaders: connectHeaders,
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
        this.isReconnecting = false;
        this.reconnectAttempts = 0;

        // Emit connection status update
        this.messageSubject.next({ action: 'status', status: 'Connected', discussionId: discussionId });

        // Subscribe to discussion updates
        const topic = '/topic/discussion/' + discussionId;
        // Unsubscribe from previous subscription if exists
        if (this.activeSubscription) {
          this.activeSubscription.unsubscribe();
          this.activeSubscription = null;
        }
        // Create new subscription and track it
        this.activeSubscription = this.stompClient.subscribe(topic, (message: any) => {
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
        const errorMessage = frame.headers?.['message'] || 'Connection error';
        // Don't clear currentDiscussionId if we're reconnecting
        if (!this.isReconnecting) {
          this.currentDiscussionId = null;
        }
        this.messageSubject.next({ action: 'status', status: `Connection error: ${errorMessage}`, discussionId: currentId });
      };

      this.stompClient.onWebSocketError = (event: any) => {
        const currentId = this.currentDiscussionId;
        this.connected = false;
        // Don't clear currentDiscussionId if we're reconnecting
        if (!this.isReconnecting) {
          this.currentDiscussionId = null;
        }
        this.messageSubject.next({ action: 'status', status: 'Connection error', discussionId: currentId });
      };

      this.stompClient.onWebSocketClose = (event: any) => {
        const currentId = this.currentDiscussionId;
        const wasConnected = this.connected;
        this.connected = false;
        
        // Clear subscription reference when connection closes (subscription is invalidated)
        // This prevents trying to unsubscribe from an invalid subscription
        this.activeSubscription = null;
        
        // If we were connected and this is an unexpected close, show disconnection
        // Also show disconnection for non-clean closes
        if (wasConnected && (!event.wasClean || event.code !== 1000)) {
          this.messageSubject.next({ action: 'status', status: 'Disconnected', discussionId: currentId });
          // Set reconnecting flag for automatic reconnection
          this.isReconnecting = true;
          this.reconnectAttempts++;
          // Show reconnecting status after a short delay (to allow reconnection to start)
          setTimeout(() => {
            if (this.isReconnecting && !this.connected) {
              this.messageSubject.next({ action: 'status', status: `Reconnecting... (attempt ${this.reconnectAttempts})`, discussionId: currentId });
            }
          }, 1000);
        } else if (wasConnected && event.wasClean && event.code === 1000) {
          // Clean close - still show disconnection but don't set reconnecting
          this.messageSubject.next({ action: 'status', status: 'Disconnected', discussionId: currentId });
          this.currentDiscussionId = null;
        } else if (!wasConnected && this.isReconnecting) {
          // Already reconnecting, update status
          this.reconnectAttempts++;
          this.messageSubject.next({ action: 'status', status: `Reconnecting... (attempt ${this.reconnectAttempts})`, discussionId: currentId });
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
      this.messageSubject.next({ action: 'status', status: 'Connection error: Failed to initialize WebSocket', discussionId: discussionId });
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnectWebSocket(): void {
    // Reset reconnection state when explicitly disconnecting
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    
    // Unsubscribe from active subscription
    if (this.activeSubscription) {
      try {
        this.activeSubscription.unsubscribe();
      } catch (error) {
        // Ignore errors during unsubscribe
      }
      this.activeSubscription = null;
    }
    
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
   * Get file URL for images/videos (returns authenticated blob URL)
   */
  getFileUrl(discussionId: string, subfolder: string, filename: string): Observable<string> {
    const baseUrl = environment.production ? '' : 'http://localhost:8000';
    const url = `${baseUrl}/api/discussions/files/${discussionId}/${subfolder}/${filename}`;
    
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(url, { headers: headers, responseType: 'blob' })
      ),
      switchMap((blob: Blob) => {
        // Check if blob is actually an error response (JSON error messages are often small)
        if (blob.size < 100 && (blob.type === 'application/json' || blob.type === 'text/plain')) {
          // Likely an error response, read it to get the error message
          return new Observable<string>((observer) => {
            const reader = new FileReader();
            reader.onload = () => {
              try {
                const errorText = reader.result as string;
                console.error('Server returned error instead of file:', errorText);
                observer.error(new Error(`Server error: ${errorText}`));
              } catch (e) {
                console.error('Error reading error response:', e);
                observer.error(new Error('Server returned error response instead of file'));
              }
            };
            reader.onerror = () => observer.error(new Error('Failed to read error response'));
            reader.readAsText(blob);
          });
        }
        const blobUrl = URL.createObjectURL(blob);
        return of(blobUrl);
      }),
      catchError((error) => {
        console.error('Error getting file URL:', url, error);
        throw error;
      })
    );
  }

  /**
   * Get active WebSocket connections for discussions
   */
  getActiveConnections(): Observable<any[]> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<any[]>(this.API_URL + 'discussions/active-connections', { headers: headers })
      )
    );
  }

  /**
   * Get discussion statistics for all users (Admin only)
   * @param userId Optional filter to get statistics for a specific user only
   */
  getDiscussionStatistics(userId?: string): Observable<DiscussionStatistics[]> {
    let url = this.API_URL + 'discussions/statistics';
    if (userId) {
      url += '?userId=' + encodeURIComponent(userId);
    }
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<DiscussionStatistics[]>(url, { headers: headers })
      )
    );
  }
}

export interface DiscussionStatistics {
  userId: string;
  userName: string;
  firstName?: string;
  lastName?: string;
  totalDiscussions: number;
  discussions: DiscussionAccessInfo[];
}

export interface DiscussionAccessInfo {
  discussionId: string;
  discussionTitle: string;
  type: 'general' | 'event' | 'friendGroup';
  accessReasons: string[];
  eventName?: string;
  friendGroupName?: string;
}

