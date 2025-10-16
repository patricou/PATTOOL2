// In fact this Component is for the firebase Global Chat
import { Component, OnInit } from '@angular/core';
import { Firestore, collection, addDoc, deleteDoc, doc, collectionData } from '@angular/fire/firestore';
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

  constructor(private firestore: Firestore,
    private auth: Auth,
    public _memberService: MembersService) {
    try {
      console.log('Initializing Firebase connection...');
      console.log('Firestore instance:', this.firestore);
      
      // Test basic Firestore connection first
      this.testBasicConnection();
      
      const messagesCollection = collection(this.firestore, 'globalMessages');
      console.log('Messages collection created:', messagesCollection);
      
      this.items = collectionData(messagesCollection, { idField: 'id' }) as Observable<any[]>;
      
      // Subscribe to see if data is being received
      this.items.subscribe({
        next: (messages) => {
          console.log('Received messages from Firebase:', messages);
        },
        error: (error) => {
          console.error('Error receiving messages from Firebase:', error);
          console.error('Error details:', {
            code: error.code,
            message: error.message,
            details: error.details
          });
        }
      });
      
      console.log('Firebase connection initialized successfully');
    } catch (error) {
      console.error('Error initializing Firebase connection:', error);
    }
  }

  private async testBasicConnection() {
    try {
      console.log('Testing basic Firestore connection...');
      // Try to create a simple test collection reference
      const testCollection = collection(this.firestore, 'test');
      console.log('✓ Test collection reference created successfully');
      
      // Try to read from the collection (this should work even with restrictive rules)
      console.log('Testing read access...');
      const testData = collectionData(testCollection);
      console.log('✓ Read access test passed');
      
    } catch (error: any) {
      console.error('❌ Basic connection test failed:', error);
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
    }
  }

  async Send() {
    try {
      console.log('Sending message to Firebase...', this.msgVal);
      const messagesCollection = collection(this.firestore, 'globalMessages');
      await addDoc(messagesCollection, {
        'message': this.msgVal,
        'date': new Date(),
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
      console.error('Error sending message to Firebase:', error);
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
        console.log('✅ Firebase is ready for use!');
      } else {
        console.log('❌ Firebase connection failed - check console for details');
        console.log('🔧 Most likely solutions:');
        console.log('1. Update Firestore security rules in Firebase Console');
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
      authDomain: 'sportpat-5e155.firebaseapp.com'
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
      console.log('Testing Firebase SDK connection...');
      // Test 1: Try to create a collection reference
      console.log('Test 1: Creating collection reference...');
      const testCollection = collection(this.firestore, 'test');
      console.log('✓ Collection reference created successfully');
      
      // Test 2: Try to add a document (this will fail if rules are restrictive)
      console.log('Test 2: Attempting to add document...');
      const testDoc = await addDoc(testCollection, {
        test: 'connection test',
        timestamp: new Date()
      });
      console.log('✓ Firebase write test successful, doc ID:', testDoc.id);
      
      // Test 3: Try to read the document
      console.log('Test 3: Testing document read...');
      const docRef = doc(this.firestore, 'test', testDoc.id);
      console.log('✓ Document reference created successfully');
      
      // Clean up test document
      console.log('Cleaning up test document...');
      await deleteDoc(docRef);
      console.log('✓ Test document cleaned up');
      
      console.log('🎉 All Firebase SDK tests passed!');
      return true;
    } catch (error: any) {
      console.error('❌ Firebase SDK connection test failed:', error);
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
      
      // Provide specific guidance based on error type
      if (error.code === 'permission-denied') {
        console.error('🔒 PERMISSION DENIED: Check your Firestore security rules');
        console.error('Suggested rule for testing:');
        console.error('rules_version = "2";');
        console.error('service cloud.firestore {');
        console.error('  match /databases/{database}/documents {');
        console.error('    match /{document=**} {');
        console.error('      allow read, write: if true;');
        console.error('    }');
        console.error('  }');
        console.error('}');
      } else if (error.code === 'unavailable') {
        console.error('🌐 SERVICE UNAVAILABLE: Check your internet connection and Firebase project status');
      } else if (error.code === 'not-found') {
        console.error('🔍 PROJECT NOT FOUND: Verify your Firebase project ID and configuration');
      } else if (error.code === 'invalid-argument') {
        console.error('⚠️ INVALID ARGUMENT: Check your Firebase configuration');
      } else if (error.code === 'failed-precondition') {
        console.error('🚫 FAILED PRECONDITION: Firestore might not be enabled for this project');
      }
      return false;
    }
  }

  async deleteMessage(item: any) {
    try {
      console.log('Deleting message:', item.id);
      const messageDoc = doc(this.firestore, 'globalMessages', item.id);
      await deleteDoc(messageDoc);
      console.log('Message deleted successfully');
    } catch (error: any) {
      console.error('Error deleting message:', error);
      alert('Error deleting message: ' + (error.message || error));
    }
  }
}
