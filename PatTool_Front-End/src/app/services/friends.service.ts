import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';

import { Member } from '../model/member';
import { FriendRequest, FriendRequestStatus, Friend } from '../model/friend';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';

@Injectable()
export class FriendsService {

    private API_URL: string = environment.API_URL;

    constructor(
        private _http: HttpClient,
        private _keycloakService: KeycloakService
    ) { }

    /**
     * Get all users from Keycloak (via backend)
     */
    getAllUsers(): Observable<Member[]> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.get<Member[]>(this.API_URL + 'friends/users', { headers: headers }).pipe(
                    map((res: any) => {
                        return res.map((user: any) => {
                            return new Member(
                                user.id || '',
                                user.addressEmail || '',
                                user.firstName || '',
                                user.lastName || '',
                                user.userName || '',
                                user.roles || [],
                                user.keycloakId || '',
                                user.registrationDate ? new Date(user.registrationDate) : undefined,
                                user.lastConnectionDate ? new Date(user.lastConnectionDate) : undefined,
                                user.locale || undefined
                            );
                        });
                    }),
                    catchError((error: any) => {
                        console.error('Error getting users:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Send a friend request
     */
    sendFriendRequest(recipientId: string): Observable<FriendRequest> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.post<FriendRequest>(
                    this.API_URL + 'friends/request',
                    { recipientId: recipientId },
                    { headers: headers }
                ).pipe(
                    map((res: any) => {
                        return new FriendRequest(
                            res.id || '',
                            res.requester ? new Member(
                                res.requester.id || '',
                                res.requester.addressEmail || '',
                                res.requester.firstName || '',
                                res.requester.lastName || '',
                                res.requester.userName || '',
                                res.requester.roles || [],
                                res.requester.keycloakId || '',
                                res.requester.registrationDate ? new Date(res.requester.registrationDate) : undefined,
                                res.requester.lastConnectionDate ? new Date(res.requester.lastConnectionDate) : undefined,
                                res.requester.locale || undefined
                            ) : new Member('', '', '', '', '', [], ''),
                            res.recipient ? new Member(
                                res.recipient.id || '',
                                res.recipient.addressEmail || '',
                                res.recipient.firstName || '',
                                res.recipient.lastName || '',
                                res.recipient.userName || '',
                                res.recipient.roles || [],
                                res.recipient.keycloakId || '',
                                res.recipient.registrationDate ? new Date(res.recipient.registrationDate) : undefined,
                                res.recipient.lastConnectionDate ? new Date(res.recipient.lastConnectionDate) : undefined,
                                res.recipient.locale || undefined
                            ) : new Member('', '', '', '', '', [], ''),
                            res.status || FriendRequestStatus.PENDING,
                            res.requestDate ? new Date(res.requestDate) : new Date(),
                            res.responseDate ? new Date(res.responseDate) : undefined
                        );
                    }),
                    catchError((error: any) => {
                        console.error('Error sending friend request:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Get sent friend requests by the current user
     */
    getSentRequests(): Observable<FriendRequest[]> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.get<FriendRequest[]>(this.API_URL + 'friends/requests/sent', { headers: headers }).pipe(
                    map((res: any) => {
                        return res.map((req: any) => {
                            return new FriendRequest(
                                req.id || '',
                                req.requester ? new Member(
                                    req.requester.id || '',
                                    req.requester.addressEmail || '',
                                    req.requester.firstName || '',
                                    req.requester.lastName || '',
                                    req.requester.userName || '',
                                    req.requester.roles || [],
                                    req.requester.keycloakId || '',
                                    req.requester.registrationDate ? new Date(req.requester.registrationDate) : undefined,
                                    req.requester.lastConnectionDate ? new Date(req.requester.lastConnectionDate) : undefined,
                                    req.requester.locale || undefined
                                ) : new Member('', '', '', '', '', [], ''),
                                req.recipient ? new Member(
                                    req.recipient.id || '',
                                    req.recipient.addressEmail || '',
                                    req.recipient.firstName || '',
                                    req.recipient.lastName || '',
                                    req.recipient.userName || '',
                                    req.recipient.roles || [],
                                    req.recipient.keycloakId || '',
                                    req.recipient.registrationDate ? new Date(req.recipient.registrationDate) : undefined,
                                    req.recipient.lastConnectionDate ? new Date(req.recipient.lastConnectionDate) : undefined,
                                    req.recipient.locale || undefined
                                ) : new Member('', '', '', '', '', [], ''),
                                req.status || FriendRequestStatus.PENDING,
                                req.requestDate ? new Date(req.requestDate) : new Date(),
                                req.responseDate ? new Date(req.responseDate) : undefined
                            );
                        });
                    }),
                    catchError((error: any) => {
                        console.error('Error getting sent requests:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Get pending friend requests for the current user
     */
    getPendingRequests(): Observable<FriendRequest[]> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.get<FriendRequest[]>(this.API_URL + 'friends/requests/pending', { headers: headers }).pipe(
                    map((res: any) => {
                        return res.map((req: any) => {
                            return new FriendRequest(
                                req.id || '',
                                req.requester ? new Member(
                                    req.requester.id || '',
                                    req.requester.addressEmail || '',
                                    req.requester.firstName || '',
                                    req.requester.lastName || '',
                                    req.requester.userName || '',
                                    req.requester.roles || [],
                                    req.requester.keycloakId || '',
                                    req.requester.registrationDate ? new Date(req.requester.registrationDate) : undefined,
                                    req.requester.lastConnectionDate ? new Date(req.requester.lastConnectionDate) : undefined,
                                    req.requester.locale || undefined
                                ) : new Member('', '', '', '', '', [], ''),
                                req.recipient ? new Member(
                                    req.recipient.id || '',
                                    req.recipient.addressEmail || '',
                                    req.recipient.firstName || '',
                                    req.recipient.lastName || '',
                                    req.recipient.userName || '',
                                    req.recipient.roles || [],
                                    req.recipient.keycloakId || '',
                                    req.recipient.registrationDate ? new Date(req.recipient.registrationDate) : undefined,
                                    req.recipient.lastConnectionDate ? new Date(req.recipient.lastConnectionDate) : undefined,
                                    req.recipient.locale || undefined
                                ) : new Member('', '', '', '', '', [], ''),
                                req.status || FriendRequestStatus.PENDING,
                                req.requestDate ? new Date(req.requestDate) : new Date(),
                                req.responseDate ? new Date(req.responseDate) : undefined
                            );
                        });
                    }),
                    catchError((error: any) => {
                        console.error('Error getting pending requests:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Approve a friend request
     */
    approveFriendRequest(requestId: string): Observable<Friend> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.put<Friend>(
                    this.API_URL + 'friends/request/' + requestId + '/approve',
                    {},
                    { headers: headers }
                ).pipe(
                    map((res: any) => {
                        return new Friend(
                            res.id || '',
                            res.user1 ? new Member(
                                res.user1.id || '',
                                res.user1.addressEmail || '',
                                res.user1.firstName || '',
                                res.user1.lastName || '',
                                res.user1.userName || '',
                                res.user1.roles || [],
                                res.user1.keycloakId || '',
                                res.user1.registrationDate ? new Date(res.user1.registrationDate) : undefined,
                                res.user1.lastConnectionDate ? new Date(res.user1.lastConnectionDate) : undefined,
                                res.user1.locale || undefined
                            ) : new Member('', '', '', '', '', [], ''),
                            res.user2 ? new Member(
                                res.user2.id || '',
                                res.user2.addressEmail || '',
                                res.user2.firstName || '',
                                res.user2.lastName || '',
                                res.user2.userName || '',
                                res.user2.roles || [],
                                res.user2.keycloakId || '',
                                res.user2.registrationDate ? new Date(res.user2.registrationDate) : undefined,
                                res.user2.lastConnectionDate ? new Date(res.user2.lastConnectionDate) : undefined,
                                res.user2.locale || undefined
                            ) : new Member('', '', '', '', '', [], ''),
                            res.friendshipDate ? new Date(res.friendshipDate) : new Date()
                        );
                    }),
                    catchError((error: any) => {
                        console.error('Error approving friend request:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Reject a friend request
     */
    rejectFriendRequest(requestId: string): Observable<any> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.put<any>(
                    this.API_URL + 'friends/request/' + requestId + '/reject',
                    {},
                    { headers: headers }
                ).pipe(
                    catchError((error: any) => {
                        console.error('Error rejecting friend request:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Get all friends of the current user
     */
    getFriends(): Observable<Friend[]> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.get<Friend[]>(this.API_URL + 'friends', { headers: headers }).pipe(
                    map((res: any) => {
                        return res.map((friend: any) => {
                            return new Friend(
                                friend.id || '',
                                friend.user1 ? new Member(
                                    friend.user1.id || '',
                                    friend.user1.addressEmail || '',
                                    friend.user1.firstName || '',
                                    friend.user1.lastName || '',
                                    friend.user1.userName || '',
                                    friend.user1.roles || [],
                                    friend.user1.keycloakId || '',
                                    friend.user1.registrationDate ? new Date(friend.user1.registrationDate) : undefined,
                                    friend.user1.lastConnectionDate ? new Date(friend.user1.lastConnectionDate) : undefined,
                                    friend.user1.locale || undefined
                                ) : new Member('', '', '', '', '', [], ''),
                                friend.user2 ? new Member(
                                    friend.user2.id || '',
                                    friend.user2.addressEmail || '',
                                    friend.user2.firstName || '',
                                    friend.user2.lastName || '',
                                    friend.user2.userName || '',
                                    friend.user2.roles || [],
                                    friend.user2.keycloakId || '',
                                    friend.user2.registrationDate ? new Date(friend.user2.registrationDate) : undefined,
                                    friend.user2.lastConnectionDate ? new Date(friend.user2.lastConnectionDate) : undefined,
                                    friend.user2.locale || undefined
                                ) : new Member('', '', '', '', '', [], ''),
                                friend.friendshipDate ? new Date(friend.friendshipDate) : new Date()
                            );
                        });
                    }),
                    catchError((error: any) => {
                        console.error('Error getting friends:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Remove a friend
     */
    removeFriend(friendId: string): Observable<any> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.delete<any>(
                    this.API_URL + 'friends/' + friendId,
                    { headers: headers }
                ).pipe(
                    catchError((error: any) => {
                        console.error('Error removing friend:', error);
                        throw error;
                    })
                );
            })
        );
    }
}

