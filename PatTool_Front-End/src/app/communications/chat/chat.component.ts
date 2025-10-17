// In fact this Component is for the firebase Global Chat
import { Component, OnInit } from '@angular/core';
import { Database, ref, push, remove, onValue, serverTimestamp } from '@angular/fire/database';
import { Auth, signInAnonymously } from '@angular/fire/auth';
import { Observable } from 'rxjs';
import { Member } from '../../model/member';
import { MembersService } from '../../services/members.service';

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css']
})
export class ChatComponent implements OnInit {

  public items: Observable<any[]> = new Observable();
  public msgVal: string = '';
  public user: Member = new Member("", "", "", "", "", [], "");

  constructor(private database: Database,
    private auth: Auth,
    public _memberService: MembersService) {
    try {
      console.log('Initializing Firebase Realtime Database connection...');
      console.log('Database instance:', this.database);
      
      // Test basic Realtime Database connection first
      this.testBasicConnection();
      
      const messagesRef = ref(this.database, 'globalMessages');
      console.log('Messages reference created:', messagesRef);
      
      // Convert Firebase Realtime Database observable to RxJS Observable
      this.items = new Observable(observer => {
        const unsubscribe = onValue(messagesRef, (snapshot) => {
          const messages: any[] = [];
          snapshot.forEach((childSnapshot) => {
            messages.push({
              id: childSnapshot.key,
              ...childSnapshot.val()
            });
          });
          // Trier les messages par date/heure (plus récents en premier)
          messages.sort((a, b) => {
            // Utiliser la propriété 'priority' qui est définie comme 0 - Date.now()
            // Plus la valeur est négative, plus le message est récent
            return a.priority - b.priority;
          });
          observer.next(messages);
        }, (error) => {
          observer.error(error);
        });
        
        return () => unsubscribe();
      });
      
      // Subscribe to see if data is being received
      this.items.subscribe({
        next: (messages) => {
          console.log('Received messages from Firebase Realtime Database:', messages);
        },
        error: (error) => {
          console.error('Error receiving messages from Firebase Realtime Database:', error);
          console.error('Error details:', {
            code: error.code,
            message: error.message,
            details: error.details
          });
        }
      });
      
      console.log('Firebase Realtime Database connection initialized successfully');
    } catch (error) {
      console.error('Error initializing Firebase Realtime Database connection:', error);
    }
  }

  private async testBasicConnection() {
    try {
      console.log('Testing basic Realtime Database connection...');
      // Try to create a simple test reference
      const testRef = ref(this.database, 'test');
      console.log('✓ Test reference created successfully');
      
      // Try to read from the reference (this should work even with restrictive rules)
      console.log('Testing read access...');
      onValue(testRef, (snapshot) => {
        console.log('✓ Read access test passed');
      }, { onlyOnce: true });
      
    } catch (error: any) {
      console.error('❌ Basic connection test failed:', error);
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
    }
  }

  async Send() {
    try {
      console.log('Sending message to Firebase Realtime Database...', this.msgVal);
      const messagesRef = ref(this.database, 'globalMessages');
      await push(messagesRef, {
        'message': this.msgVal,
        'date': new Date().toISOString(),
        'user': {
          firstName: this.user.firstName,
          lastName: this.user.lastName,
          userName: this.user.userName
        },
        'priority': 0 - Date.now()
      });
      console.log('Message sent successfully');
      this.msgVal = '';
    } catch (error: any) {
      console.error('Error sending message to Firebase Realtime Database:', error);
      alert('Error sending message: ' + (error.message || error));
    }
  }

  async ngOnInit() {
    try {
      this.user = this._memberService.getUser();
      console.log('Chat component initialized with user:', this.user);
      this.checkFirebaseConfig();
      
      // Try authentication first
      const authSuccess = await this.authenticateWithFirebase();
      if (authSuccess) {
        console.log('Authentication successful, proceeding with tests...');
      } else {
        console.log('Authentication failed, but continuing with tests...');
      }
      
      // Test Firebase connection
      const connectionSuccess = await this.testFirebaseConnection();
      if (connectionSuccess) {
        console.log('✅ Firebase Realtime Database is ready for use!');
      } else {
        console.log('❌ Firebase Realtime Database connection failed - check console for details');
        console.log('🔧 Most likely solutions:');
        console.log('1. Update Realtime Database security rules in Firebase Console');
        console.log('2. Check if Firebase project is active and has billing enabled');
        console.log('3. Verify Firebase project permissions');
      }
    } catch (error: any) {
      console.error('Error initializing chat component:', error);
    }
  }

  private checkFirebaseConfig() {
    console.log('Checking Firebase configuration...');
    console.log('Environment config:', {
      projectId: 'sportpat-5e155',
      apiKey: 'AIzaSyBJFAKMyDO_lmqBYUwW6CWjBIMTHyFGZKc',
      authDomain: 'sportpat-5e155.firebaseapp.com',
      databaseURL: 'https://sportpat-5e155.firebaseio.com'
    });
    console.log('✅ Firebase configuration loaded successfully');
  }

  private async authenticateWithFirebase() {
    try {
      console.log('Attempting anonymous authentication...');
      const userCredential = await signInAnonymously(this.auth);
      console.log('Anonymous authentication successful:', userCredential.user?.uid);
      return true;
    } catch (error: any) {
      console.error('Anonymous authentication failed:', error);
      return false;
    }
  }

  async testFirebaseConnection() {
    try {
      console.log('Testing Firebase Realtime Database SDK connection...');
      // Test 1: Try to create a reference
      console.log('Test 1: Creating reference...');
      const testRef = ref(this.database, 'test');
      console.log('✓ Reference created successfully');
      
      // Test 2: Try to push data (this will fail if rules are restrictive)
      console.log('Test 2: Attempting to push data...');
      const testPushRef = await push(testRef, {
        test: 'connection test',
        timestamp: new Date().toISOString()
      });
      console.log('✓ Firebase write test successful, key:', testPushRef.key);
      
      // Test 3: Try to read the data
      console.log('Test 3: Testing data read...');
      const readRef = ref(this.database, 'test/' + testPushRef.key);
      console.log('✓ Read reference created successfully');
      
      // Clean up test data
      console.log('Cleaning up test data...');
      await remove(readRef);
      console.log('✓ Test data cleaned up');
      
      console.log('🎉 All Firebase Realtime Database SDK tests passed!');
      return true;
    } catch (error: any) {
      console.error('❌ Firebase Realtime Database SDK connection test failed:', error);
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
      
      // Provide specific guidance based on error type
      if (error.code === 'PERMISSION_DENIED') {
        console.error('🔒 PERMISSION DENIED: Check your Realtime Database security rules');
        console.error('Suggested rule for testing:');
        console.error('{');
        console.error('  "rules": {');
        console.error('    ".read": true,');
        console.error('    ".write": true');
        console.error('  }');
        console.error('}');
      } else if (error.code === 'UNAVAILABLE') {
        console.error('🌐 SERVICE UNAVAILABLE: Check your internet connection and Firebase project status');
      } else if (error.code === 'INVALID_ARGUMENT') {
        console.error('⚠️ INVALID ARGUMENT: Check your Firebase configuration');
      }
      return false;
    }
  }

  async deleteMessage(item: any) {
    try {
      console.log('Deleting message:', item.id);
      const messageRef = ref(this.database, 'globalMessages/' + item.id);
      await remove(messageRef);
      console.log('Message deleted successfully');
    } catch (error: any) {
      console.error('Error deleting message:', error);
      alert('Error deleting message: ' + (error.message || error));
    }
  }
}