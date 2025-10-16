package com.pat.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.DBRef;

/**
 * Created by patricou on 5/8/2017.
 */
public class FileUploaded {

    //note : I have not created any @id as the object is not saved in a particular collection,
    // but in one Evenement
    //.....

    private String fieldId;
    private String fileName;
    private String fileType;
    @DBRef
    private Member uploaderMember;

    public String getFieldId() {
        return fieldId;
    }

    public void setFieldId(String fieldId) {
        this.fieldId = fieldId;
    }

    public String getFileName() {
        return fileName;
    }

    public void setFileName(String fileName) {
        this.fileName = fileName;
    }

    public String getFileType() {
        return fileType;
    }

    public void setFileType(String fileType) {
        this.fileType = fileType;
    }

    public Member getUploaderMember() {
        return uploaderMember;
    }

    public void setUploaderMember(Member uploaderMember) {
        this.uploaderMember = uploaderMember;
    }

    public FileUploaded(String fieldId, String fileName, String fileType, Member uploaderMember) {
        this.fieldId = fieldId;
        this.fileName = fileName;
        this.fileType = fileType;
        this.uploaderMember = uploaderMember;
    }

    public FileUploaded(){};
}
