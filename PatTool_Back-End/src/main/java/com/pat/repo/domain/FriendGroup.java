package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.DBRef;
import org.springframework.data.mongodb.core.mapping.Document;

import jakarta.validation.constraints.NotNull;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

@Document(collection = "friendgroups")
public class FriendGroup {
    
    @Id
    private String id;
    
    @NotNull
    private String name;
    
    @NotNull
    @DBRef
    private List<Member> members = new ArrayList<>();
    
    @NotNull
    @DBRef
    private Member owner;
    
    @DBRef
    private List<Member> authorizedUsers = new ArrayList<>(); // Users authorized to use this group (but not to add members)
    
    @NotNull
    private Date creationDate;
    
    private String discussionId; // ID of the discussion associated with this friend group

    private String whatsappLink; // WhatsApp group link or invite link for this friend group

    public FriendGroup() {
    }

    public FriendGroup(String name, List<Member> members, Member owner, Date creationDate) {
        this.name = name;
        this.members = members != null ? members : new ArrayList<>();
        this.owner = owner;
        this.creationDate = creationDate;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public List<Member> getMembers() {
        return members;
    }

    public void setMembers(List<Member> members) {
        this.members = members != null ? members : new ArrayList<>();
    }

    public Member getOwner() {
        return owner;
    }

    public void setOwner(Member owner) {
        this.owner = owner;
    }

    public Date getCreationDate() {
        return creationDate;
    }

    public void setCreationDate(Date creationDate) {
        this.creationDate = creationDate;
    }

    public List<Member> getAuthorizedUsers() {
        return authorizedUsers;
    }

    public void setAuthorizedUsers(List<Member> authorizedUsers) {
        this.authorizedUsers = authorizedUsers != null ? authorizedUsers : new ArrayList<>();
    }

    public String getDiscussionId() {
        return discussionId;
    }

    public void setDiscussionId(String discussionId) {
        this.discussionId = discussionId;
    }

    public String getWhatsappLink() {
        return whatsappLink;
    }

    public void setWhatsappLink(String whatsappLink) {
        this.whatsappLink = whatsappLink;
    }
}

