import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from, of } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';

import { Member } from '../model/member';
import { FriendRequest, FriendRequestStatus, Friend, FriendGroup } from '../model/friend';
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
                                user.locale || undefined,
                                user.whatsappLink || undefined
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
    sendFriendRequest(recipientId: string, message?: string): Observable<FriendRequest> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                const body: any = { recipientId: recipientId };
                if (message && message.trim()) {
                    body.message = message.trim();
                }
                return this._http.post<FriendRequest>(
                    this.API_URL + 'friends/request',
                    body,
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
                                res.requester.locale || undefined,
                                res.requester.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
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
                                res.recipient.locale || undefined,
                                res.recipient.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
                            res.status || FriendRequestStatus.PENDING,
                            res.requestDate ? new Date(res.requestDate) : new Date(),
                            res.responseDate ? new Date(res.responseDate) : undefined,
                            res.message
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
                                    req.requester.locale || undefined,
                                    req.requester.whatsappLink || undefined
                                ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
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
                                    req.recipient.locale || undefined,
                                    req.recipient.whatsappLink || undefined
                                ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
                                req.status || FriendRequestStatus.PENDING,
                                req.requestDate ? new Date(req.requestDate) : new Date(),
                                req.responseDate ? new Date(req.responseDate) : undefined,
                                req.message
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
                                    req.requester.locale || undefined,
                                    req.requester.whatsappLink || undefined
                                ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
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
                                    req.recipient.locale || undefined,
                                    req.recipient.whatsappLink || undefined
                                ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
                                req.status || FriendRequestStatus.PENDING,
                                req.requestDate ? new Date(req.requestDate) : new Date(),
                                req.responseDate ? new Date(req.responseDate) : undefined,
                                req.message
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
                                res.user1.locale || undefined,
                                res.user1.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
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
                                res.user2.locale || undefined,
                                res.user2.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
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
     * Cancel a sent friend request (by the requester)
     */
    cancelSentFriendRequest(requestId: string): Observable<any> {
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
                    this.API_URL + 'friends/request/' + requestId + '/cancel',
                    { headers: headers }
                ).pipe(
                    catchError((error: any) => {
                        console.error('Error canceling sent friend request:', error);
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
                                    friend.user1.locale || undefined,
                                    friend.user1.whatsappLink || undefined
                                ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
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
                                    friend.user2.locale || undefined,
                                    friend.user2.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
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

    /**
     * Update WhatsApp link for a friend
     */
    updateMemberWhatsappLink(memberId: string, whatsappLink: string): Observable<Member> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                const body = { whatsappLink: whatsappLink || null };
                return this._http.put<any>(this.API_URL + 'friends/members/' + memberId + '/whatsapp', body, { headers: headers }).pipe(
                    map((res: any) => {
                        return new Member(
                            res.id || '',
                            res.addressEmail || '',
                            res.firstName || '',
                            res.lastName || '',
                            res.userName || '',
                            res.roles || [],
                            res.keycloakId || '',
                            res.registrationDate ? new Date(res.registrationDate) : undefined,
                            res.lastConnectionDate ? new Date(res.lastConnectionDate) : undefined,
                            res.locale || undefined,
                            res.whatsappLink || undefined
                        );
                    })
                );
            })
        );
    }

    /**
     * Check if an email address belongs to an existing member
     */
    checkEmail(email: string): Observable<{ exists: boolean; memberId?: string; userName?: string }> {
        return from(this._keycloakService.getToken()).pipe(
            map(token => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.get<{ exists: boolean; memberId?: string; userName?: string }>(
                    this.API_URL + 'friends/check-email/' + encodeURIComponent(email),
                    { headers: headers }
                ).pipe(
                    catchError((error: any) => {
                        console.error('Error checking email:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Send invitation email to join PATTOOL
     */
    sendInvitation(email: string, customMessage?: string): Observable<{ message: string }> {
        return from(this._keycloakService.getToken()).pipe(
            map(token => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                const body: any = { email };
                if (customMessage && customMessage.trim()) {
                    body.customMessage = customMessage.trim();
                }
                return this._http.post<{ message: string }>(
                    this.API_URL + 'friends/invite',
                    body,
                    { headers: headers }
                ).pipe(
                    catchError((error: any) => {
                        console.error('Error sending invitation:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Create a new friend group
     */
    createFriendGroup(name: string, memberIds: string[]): Observable<FriendGroup> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.post<FriendGroup>(
                    this.API_URL + 'friends/groups',
                    { name, memberIds },
                    { headers: headers }
                ).pipe(
                    map((res: any) => {
                        return new FriendGroup(
                            res.id || '',
                            res.name || '',
                            (res.members || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.owner ? new Member(
                                res.owner.id || '',
                                res.owner.addressEmail || '',
                                res.owner.firstName || '',
                                res.owner.lastName || '',
                                res.owner.userName || '',
                                res.owner.roles || [],
                                res.owner.keycloakId || '',
                                res.owner.registrationDate ? new Date(res.owner.registrationDate) : undefined,
                                res.owner.lastConnectionDate ? new Date(res.owner.lastConnectionDate) : undefined,
                                res.owner.locale || undefined,
                                res.owner.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
                            res.creationDate ? new Date(res.creationDate) : new Date(),
                            (res.authorizedUsers || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.discussionId,
                            res.whatsappLink
                        );
                    }),
                    catchError((error: any) => {
                        console.error('Error creating friend group:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Get all friend groups for the current user
     */
    getFriendGroups(): Observable<FriendGroup[]> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.get<FriendGroup[]>(this.API_URL + 'friends/groups', { headers: headers }).pipe(
                    map((res: any) => {
                        return res.map((group: any) => {
                            return new FriendGroup(
                                group.id || '',
                                group.name || '',
                                (group.members || []).map((m: any) => new Member(
                                    m.id || '',
                                    m.addressEmail || '',
                                    m.firstName || '',
                                    m.lastName || '',
                                    m.userName || '',
                                    m.roles || [],
                                    m.keycloakId || '',
                                    m.registrationDate ? new Date(m.registrationDate) : undefined,
                                    m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                    m.locale || undefined
                                )),
                                group.owner ? new Member(
                                    group.owner.id || '',
                                    group.owner.addressEmail || '',
                                    group.owner.firstName || '',
                                    group.owner.lastName || '',
                                    group.owner.userName || '',
                                    group.owner.roles || [],
                                    group.owner.keycloakId || '',
                                    group.owner.registrationDate ? new Date(group.owner.registrationDate) : undefined,
                                    group.owner.lastConnectionDate ? new Date(group.owner.lastConnectionDate) : undefined,
                                    group.owner.locale || undefined
                                ) : new Member('', '', '', '', '', [], ''),
                                group.creationDate ? new Date(group.creationDate) : new Date(),
                                (group.authorizedUsers || []).map((m: any) => new Member(
                                    m.id || '',
                                    m.addressEmail || '',
                                    m.firstName || '',
                                    m.lastName || '',
                                    m.userName || '',
                                    m.roles || [],
                                    m.keycloakId || '',
                                    m.registrationDate ? new Date(m.registrationDate) : undefined,
                                    m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                    m.locale || undefined
                                )),
                                group.discussionId,
                                group.whatsappLink
                            );
                        });
                    }),
                    catchError((error: any) => {
                        console.error('Error getting friend groups:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Get a specific friend group by ID
     */
    getFriendGroup(groupId: string): Observable<FriendGroup> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.get<FriendGroup>(this.API_URL + 'friends/groups/' + groupId, { headers: headers }).pipe(
                    map((res: any) => {
                        return new FriendGroup(
                            res.id || '',
                            res.name || '',
                            (res.members || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.owner ? new Member(
                                res.owner.id || '',
                                res.owner.addressEmail || '',
                                res.owner.firstName || '',
                                res.owner.lastName || '',
                                res.owner.userName || '',
                                res.owner.roles || [],
                                res.owner.keycloakId || '',
                                res.owner.registrationDate ? new Date(res.owner.registrationDate) : undefined,
                                res.owner.lastConnectionDate ? new Date(res.owner.lastConnectionDate) : undefined,
                                res.owner.locale || undefined,
                                res.owner.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
                            res.creationDate ? new Date(res.creationDate) : new Date(),
                            (res.authorizedUsers || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.discussionId,
                            res.whatsappLink
                        );
                    }),
                    catchError((error: any) => {
                        console.error('Error getting friend group:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Update a friend group
     */
    updateFriendGroup(groupId: string, name: string, memberIds: string[], discussionId?: string, whatsappLink?: string): Observable<FriendGroup> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                const body: any = { name, memberIds };
                // Always include discussionId in body (even if undefined) so backend can clear it
                // Use null for JSON serialization when undefined
                body.discussionId = discussionId !== undefined ? discussionId : null;
                // Include whatsappLink if provided
                if (whatsappLink !== undefined) {
                    body.whatsappLink = whatsappLink;
                }
                return this._http.put<FriendGroup>(
                    this.API_URL + 'friends/groups/' + groupId,
                    body,
                    { headers: headers }
                ).pipe(
                    map((res: any) => {
                        return new FriendGroup(
                            res.id || '',
                            res.name || '',
                            (res.members || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.owner ? new Member(
                                res.owner.id || '',
                                res.owner.addressEmail || '',
                                res.owner.firstName || '',
                                res.owner.lastName || '',
                                res.owner.userName || '',
                                res.owner.roles || [],
                                res.owner.keycloakId || '',
                                res.owner.registrationDate ? new Date(res.owner.registrationDate) : undefined,
                                res.owner.lastConnectionDate ? new Date(res.owner.lastConnectionDate) : undefined,
                                res.owner.locale || undefined,
                                res.owner.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
                            res.creationDate ? new Date(res.creationDate) : new Date(),
                            (res.authorizedUsers || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.discussionId,
                            res.whatsappLink
                        );
                    }),
                    catchError((error: any) => {
                        console.error('Error updating friend group:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Delete a friend group
     */
    deleteFriendGroup(groupId: string): Observable<any> {
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
                    this.API_URL + 'friends/groups/' + groupId,
                    { headers: headers }
                ).pipe(
                    catchError((error: any) => {
                        console.error('Error deleting friend group:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Authorize a user to use a friend group (but not to add members)
     */
    authorizeUserForGroup(groupId: string, userId: string): Observable<FriendGroup> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.post<FriendGroup>(
                    this.API_URL + 'friends/groups/' + groupId + '/authorize/' + userId,
                    {},
                    { headers: headers }
                ).pipe(
                    map((res: any) => {
                        return new FriendGroup(
                            res.id || '',
                            res.name || '',
                            (res.members || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.owner ? new Member(
                                res.owner.id || '',
                                res.owner.addressEmail || '',
                                res.owner.firstName || '',
                                res.owner.lastName || '',
                                res.owner.userName || '',
                                res.owner.roles || [],
                                res.owner.keycloakId || '',
                                res.owner.registrationDate ? new Date(res.owner.registrationDate) : undefined,
                                res.owner.lastConnectionDate ? new Date(res.owner.lastConnectionDate) : undefined,
                                res.owner.locale || undefined,
                                res.owner.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
                            res.creationDate ? new Date(res.creationDate) : new Date(),
                            (res.authorizedUsers || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.discussionId,
                            res.whatsappLink
                        );
                    }),
                    catchError((error: any) => {
                        console.error('Error authorizing user for group:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Remove authorization for a user from a friend group
     */
    unauthorizeUserForGroup(groupId: string, userId: string): Observable<FriendGroup> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.delete<FriendGroup>(
                    this.API_URL + 'friends/groups/' + groupId + '/authorize/' + userId,
                    { headers: headers }
                ).pipe(
                    map((res: any) => {
                        return new FriendGroup(
                            res.id || '',
                            res.name || '',
                            (res.members || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.owner ? new Member(
                                res.owner.id || '',
                                res.owner.addressEmail || '',
                                res.owner.firstName || '',
                                res.owner.lastName || '',
                                res.owner.userName || '',
                                res.owner.roles || [],
                                res.owner.keycloakId || '',
                                res.owner.registrationDate ? new Date(res.owner.registrationDate) : undefined,
                                res.owner.lastConnectionDate ? new Date(res.owner.lastConnectionDate) : undefined,
                                res.owner.locale || undefined,
                                res.owner.whatsappLink || undefined
                            ) : new Member('', '', '', '', '', [], '', undefined, undefined, undefined, undefined),
                            res.creationDate ? new Date(res.creationDate) : new Date(),
                            (res.authorizedUsers || []).map((m: any) => new Member(
                                m.id || '',
                                m.addressEmail || '',
                                m.firstName || '',
                                m.lastName || '',
                                m.userName || '',
                                m.roles || [],
                                m.keycloakId || '',
                                m.registrationDate ? new Date(m.registrationDate) : undefined,
                                m.lastConnectionDate ? new Date(m.lastConnectionDate) : undefined,
                                m.locale || undefined,
                                m.whatsappLink || undefined
                            )),
                            res.discussionId,
                            res.whatsappLink
                        );
                    }),
                    catchError((error: any) => {
                        console.error('Error unauthorizing user for group:', error);
                        throw error;
                    })
                );
            })
        );
    }

    /**
     * Get user status (online/offline) from Keycloak
     */
    getUserStatus(userId: string): Observable<{ online: boolean; status: string }> {
        return from(this._keycloakService.getToken()).pipe(
            map((token: string) => {
                return new HttpHeaders({
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                });
            }),
            switchMap(headers => {
                return this._http.get<{ online: boolean; status: string }>(
                    this.API_URL + 'friends/users/' + userId + '/status',
                    { headers: headers }
                ).pipe(
                    catchError((error: any) => {
                        console.error('Error getting user status:', error);
                        // Return offline status on error
                        return of({ online: false, status: 'unknown' });
                    })
                );
            })
        );
    }
}

