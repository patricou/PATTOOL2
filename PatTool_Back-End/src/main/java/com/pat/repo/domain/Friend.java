package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.DBRef;
import org.springframework.data.mongodb.core.mapping.Document;

import jakarta.validation.constraints.NotNull;
import java.util.Date;

@Document(collection = "friends")
public class Friend {
    
    @Id
    private String id;
    
    @NotNull
    @DBRef
    private Member user1;
    
    @NotNull
    @DBRef
    private Member user2;
    
    @NotNull
    private Date friendshipDate;

    public Friend() {
    }

    public Friend(Member user1, Member user2, Date friendshipDate) {
        this.user1 = user1;
        this.user2 = user2;
        this.friendshipDate = friendshipDate;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public Member getUser1() {
        return user1;
    }

    public void setUser1(Member user1) {
        this.user1 = user1;
    }

    public Member getUser2() {
        return user2;
    }

    public void setUser2(Member user2) {
        this.user2 = user2;
    }

    public Date getFriendshipDate() {
        return friendshipDate;
    }

    public void setFriendshipDate(Date friendshipDate) {
        this.friendshipDate = friendshipDate;
    }
}

