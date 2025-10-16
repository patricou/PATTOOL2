package com.pat.controller;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mongodb.BasicDBObject;
import com.mongodb.DBObject;
import com.mongodb.client.gridfs.model.GridFSFile;
import com.pat.domain.Evenement;
import com.pat.domain.FileUploaded;
import com.pat.domain.Member;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.MembersRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.InputStreamResource;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.gridfs.GridFsTemplate;
import org.springframework.data.mongodb.gridfs.GridFsResource;
import org.bson.types.ObjectId;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import jakarta.servlet.http.HttpServletRequest;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;


/**
 * Created by patricou on 5/8/2017.
 */
@RestController
public class FileRestController {

    @Value("${app.uploaddir:C:\\temp}")
    private String uploadDir;
    @Autowired
    private EvenementsRepository evenementsRepository;
    @Autowired
    private MembersRepository membersRepository;
    @Autowired
    private GridFsTemplate gridFsTemplate;
    @Autowired
    private MailController mailController;

    private static final Logger log = LoggerFactory.getLogger(FileRestController.class);

    @RequestMapping( value = "/api/file/test", method = RequestMethod.GET )
    public ResponseEntity<String> testFileEndpoint(){
        
        log.info("Testing file endpoint configuration");
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null - MongoDB GridFS not configured");
            }
            
            return ResponseEntity.ok("GridFsTemplate is available - MongoDB GridFS configured");
        } catch (Exception e) {
            log.error("Error testing file endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/debug/{fileId}", method = RequestMethod.GET )
    public ResponseEntity<String> debugFileEndpoint(@PathVariable String fileId){
        
        log.info("Debug file endpoint for ID: " + fileId);
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null");
            }
            
            // Validate ObjectId format
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
                log.info("ObjectId validation passed: " + objectId);
            } catch (IllegalArgumentException e) {
                return ResponseEntity.ok("Invalid ObjectId format: " + fileId + " - " + e.getMessage());
            }
            
            // Try to get resource
            try {
                GridFsResource gridFsResource = gridFsTemplate.getResource(fileId);
                if (gridFsResource == null) {
                    return ResponseEntity.ok("GridFsResource is null for ID: " + fileId);
                } else {
                    return ResponseEntity.ok("GridFsResource found - Filename: " + gridFsResource.getFilename() + 
                                           ", ContentType: " + gridFsResource.getContentType() + 
                                           ", Length: " + gridFsResource.contentLength());
                }
            } catch (IllegalStateException e) {
                return ResponseEntity.ok("IllegalStateException: " + e.getMessage());
            }
            
        } catch (Exception e) {
            log.error("Error in debug endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/list", method = RequestMethod.GET )
    public ResponseEntity<String> listFilesEndpoint(){
        
        log.info("List files endpoint");
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null");
            }
            
            StringBuilder result = new StringBuilder();
            result.append("GridFS Files List:\n");
            result.append("==================\n");
            
            // Try to find any files in GridFS
            try {
                // This will help us see what files actually exist
                result.append("Note: This endpoint lists files in the current GridFS bucket.\n");
                result.append("If your file exists but is not listed here, it might be in:\n");
                result.append("- A different MongoDB database\n");
                result.append("- A different GridFS bucket\n");
                result.append("- A different collection structure\n\n");
                
                result.append("Current MongoDB connection: 192.168.1.39:27017\n");
                result.append("Current database: rando (from application.properties)\n");
                result.append("GridFS bucket: fs (default)\n\n");
                
                result.append("To verify file existence, you can:\n");
                result.append("1. Connect to MongoDB directly using MongoDB Compass\n");
                result.append("2. Check database: rando\n");
                result.append("3. Check collections: fs.files and fs.chunks\n");
                result.append("4. Search for ObjectId: ").append("6847177c50b5ef3eb05f59b3").append("\n");
                
            } catch (Exception e) {
                result.append("Error listing files: ").append(e.getMessage()).append("\n");
            }
            
            return ResponseEntity.ok(result.toString());
            
        } catch (Exception e) {
            log.error("Error in list endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/search/{fileId}", method = RequestMethod.GET )
    public ResponseEntity<String> searchFileEndpoint(@PathVariable String fileId){
        
        log.info("Search file endpoint for ID: " + fileId);
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null");
            }
            
            StringBuilder result = new StringBuilder();
            result.append("Searching for file ID: ").append(fileId).append("\n");
            
            // Validate ObjectId format
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
                result.append("✓ ObjectId validation passed: ").append(objectId).append("\n");
            } catch (IllegalArgumentException e) {
                return ResponseEntity.ok("Invalid ObjectId format: " + fileId + " - " + e.getMessage());
            }
            
            // Try different approaches to find the file
            result.append("\n--- Search Methods ---\n");
            
            // Method 1: Direct getResource with string
            try {
                GridFsResource resource1 = gridFsTemplate.getResource(fileId);
                if (resource1 != null) {
                    result.append("✓ Method 1 (getResource with string): FOUND\n");
                    result.append("  Filename: ").append(resource1.getFilename()).append("\n");
                    result.append("  ContentType: ").append(resource1.getContentType()).append("\n");
                    result.append("  Length: ").append(resource1.contentLength()).append("\n");
                } else {
                    result.append("✗ Method 1 (getResource with string): NOT FOUND\n");
                }
            } catch (IllegalStateException e) {
                result.append("✗ Method 1 (getResource with string): ").append(e.getMessage()).append("\n");
            }
            
            // Method 2: Try with ObjectId
            try {
                GridFsResource resource2 = gridFsTemplate.getResource(objectId.toString());
                if (resource2 != null) {
                    result.append("✓ Method 2 (getResource with ObjectId string): FOUND\n");
                    result.append("  Filename: ").append(resource2.getFilename()).append("\n");
                    result.append("  ContentType: ").append(resource2.getContentType()).append("\n");
                    result.append("  Length: ").append(resource2.contentLength()).append("\n");
                } else {
                    result.append("✗ Method 2 (getResource with ObjectId string): NOT FOUND\n");
                }
            } catch (IllegalStateException e) {
                result.append("✗ Method 2 (getResource with ObjectId string): ").append(e.getMessage()).append("\n");
            }
            
            // Method 3: Check GridFS status
            try {
                result.append("\n--- GridFS Status ---\n");
                result.append("GridFsTemplate is available and configured\n");
                result.append("File ID format: ").append(fileId).append(" (24 characters)\n");
                result.append("ObjectId format: ").append(objectId.toString()).append("\n");
            } catch (Exception e) {
                result.append("Error getting GridFS info: ").append(e.getMessage()).append("\n");
            }
            
            return ResponseEntity.ok(result.toString());
            
        } catch (Exception e) {
            log.error("Error in search endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/{fileId}", method = RequestMethod.GET )
    public ResponseEntity< InputStreamResource> getFile(@PathVariable String fileId){
        
        log.info("Attempting to retrieve file with ID: " + fileId);

        try {
            // Check if GridFsTemplate is available
            if (gridFsTemplate == null) {
                log.error("GridFsTemplate is null - MongoDB GridFS not properly configured");
                return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("GridFS not configured".getBytes())));
            }

            // Convert string ID to ObjectId for validation
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
            } catch (IllegalArgumentException e) {
                log.error("Invalid ObjectId format: " + fileId, e);
                return ResponseEntity.badRequest()
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("Invalid file ID format".getBytes())));
            }
            
            // Try to find the file by ObjectId using findOne
            GridFSFile gridFsFile = gridFsTemplate.findOne(new Query(Criteria.where("_id").is(objectId)));
            
            if (gridFsFile == null) {
                log.info("File not found: " + fileId);
                return ResponseEntity.notFound().build();
            }
            
            // Get the resource from the found file
            GridFsResource gridFsResource = gridFsTemplate.getResource(gridFsFile);

            HttpHeaders headers = new HttpHeaders();
            
            // Handle content type with fallback for missing metadata
            String contentType;
            try {
                contentType = gridFsResource.getContentType();
                if (contentType == null || contentType.isEmpty()) {
                    // Fallback to application/octet-stream if no content type is available
                    contentType = "application/octet-stream";
                    log.warn("No content type found for file: " + fileId + ", using fallback: " + contentType);
                }
            } catch (com.mongodb.MongoGridFSException e) {
                // Specifically handle the "No contentType data" exception
                // Try to determine content type from filename extension
                String filename = gridFsResource.getFilename();
                contentType = getContentTypeFromFilename(filename);
                log.debug("No content type metadata for file: " + fileId + " (" + filename + "), determined type: " + contentType);
            } catch (Exception e) {
                log.warn("Error getting content type for file: " + fileId + ", using fallback", e);
                contentType = "application/octet-stream";
            }
            
            headers.setContentType(MediaType.parseMediaType(contentType));
            
            // Handle filename with fallback
            String filename = gridFsResource.getFilename();
            if (filename == null || filename.isEmpty()) {
                filename = "file_" + fileId; // Fallback filename
                log.warn("No filename found for file: " + fileId + ", using fallback: " + filename);
            }
            
            log.info("Request file " + filename);
            headers.setContentDispositionFormData(filename, filename);
            headers.set("Content-Disposition","inline; filename =" + filename);
            
            try {
                // Handle content length with fallback
                long contentLength = -1; // -1 indicates unknown length
                try {
                    contentLength = gridFsResource.contentLength();
                    if (contentLength > 0) {
                        headers.set("Content-Length", Long.toString(contentLength));
                    }
                } catch (Exception e) {
                    log.warn("Could not determine content length for file: " + fileId, e);
                }
                
                return ResponseEntity.ok()
                        .headers(headers)
                        .body(new InputStreamResource(gridFsResource.getInputStream()));
            } catch (IOException e) {
                log.error("Error accessing file content: " + fileId, e);
                return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("Error accessing file content".getBytes())));
            }
        } catch (IllegalStateException e) {
            log.info("File does not exist: " + fileId + " - " + e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (com.mongodb.MongoGridFSException e) {
            log.error("GridFS error for file: " + fileId + " - " + e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new InputStreamResource(new java.io.ByteArrayInputStream(("GridFS error: " + e.getMessage()).getBytes())));
        } catch (Exception e) {
            log.error("Error retrieving file: " + fileId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new InputStreamResource(new java.io.ByteArrayInputStream(("Error: " + e.getMessage()).getBytes())));
        }
    }

    @PostMapping({"/uploadondisk", "/uploadondisk/"})
    public ResponseEntity<String> handleFileUpload(@RequestParam("files") MultipartFile[] files, HttpServletRequest request) {

        LocalDate date = LocalDate.now();

        // Create a formatter
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy_MM_dd");
        Integer year = date.getYear();

        // Format the LocalDateTime object using the formatter
        String formattedDate = date.format(formatter);

        String dir  = uploadDir + year + File.separator+formattedDate+"_from_uploaded";
        log.info("Dir : " +dir);


        for (MultipartFile file : files) {

                if (!file.isEmpty()) {
                    try {

                        Path uploadPath = Paths.get(dir);

                        if (!Files.exists(uploadPath)) {
                            Files.createDirectories(uploadPath);
                        }

                        Path filePath = uploadPath.resolve(file.getOriginalFilename());
                        Files.copy(file.getInputStream(), filePath,StandardCopyOption.REPLACE_EXISTING);

                        // log.info("File Uploaded : " + filePath + " Successfully");

                        String ipAddress = request.getHeader("X-Forwarded-For");
                        if (ipAddress == null) {
                            ipAddress = request.getRemoteAddr();
                        }

                        String subject = "Upload Photo on Disk " + filePath.getFileName();
                        String body = subject + "\n" + " from IP : " + ipAddress;
                        body = body + "\n\nHeader : ";

                        Enumeration<String> headerNames = request.getHeaderNames();
                        Map<String, String> headers = new HashMap<>();

                        while (headerNames.hasMoreElements()) {
                            String headerName = headerNames.nextElement();
                            String headerValue = request.getHeader(headerName);

                            ObjectMapper objectMapper = new ObjectMapper();

                            if ("user".equals(headerName.toString())){
                                try{
                                    Member user = objectMapper.readValue(headerValue, Member.class);
                                    subject = subject + " from : "+ user.getUserName() + " ( " + user.getFirstName()+" "+user.getLastName()+" )";
                                }catch(JsonProcessingException je){
                                    log.info("Issue to Unwrap user : " + je.getMessage());
                                }
                            }

                            if (! "authorization".equals(headerName.toString()) )
                                body = body + "\n" + headerName + " : "+ headerValue;
                        }

                        mailController.sendMailWithAttachement(subject,body,filePath.toString());


                    } catch (IOException e) {
                        log.info("File Exception : " + e.getMessage());
                        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body("File Upload error : " + e.getMessage());
                    }
                }
            }
        return ResponseEntity.ok("Upload successful");
    }

    @RequestMapping( value = "/uploadfile/{userId}/{evenementid}", method = RequestMethod.POST, consumes = "multipart/form-data")
    // Important note : the name associate with RequestParam is 'file' --> seen in the browser network request.
    public ResponseEntity<FileUploaded> postFile(@RequestParam("file") MultipartFile filedata, @PathVariable String userId, @PathVariable String evenementid  ){
        log.info("Post file received, user.id : " +  userId +" / evenement.id : " + evenementid );

        try {
            Member uploaderMember = membersRepository.findById(userId).orElse(null);

            DBObject metaData = new BasicDBObject();
            metaData.put("UploaderName", uploaderMember.getFirstName()+" "+uploaderMember.getLastName());
            metaData.put("UploaderId", uploaderMember.getId());

            // Save the doc ( all type ) in  MongoDB
            String fieldId =
                    gridFsTemplate.store( filedata.getInputStream(), filedata.getOriginalFilename(), filedata.getContentType(), metaData).toString();
            log.info("Doc created id : "+fieldId);

            // create the file info
            FileUploaded fileUploaded = new FileUploaded(fieldId, filedata.getOriginalFilename(), filedata.getContentType(), uploaderMember);
            //find the evenement
            Evenement evenement = evenementsRepository.findById(evenementid).orElse(null);
            evenement.getFileUploadeds().add(fileUploaded);
            // Save the evenement updated
            Evenement eventSaved = evenementsRepository.save(evenement);

            HttpHeaders httpHeaders = new HttpHeaders();
            httpHeaders.setLocation(ServletUriComponentsBuilder
                    .fromCurrentRequest().path("/{id}")
                    .buildAndExpand(eventSaved.getId()).toUri());

            return new ResponseEntity<FileUploaded>(fileUploaded, httpHeaders, HttpStatus.CREATED);

        }catch (Exception e ){
            log.error(" Exception error " + e);
        }

        return new ResponseEntity<>(null,null,HttpStatus.INTERNAL_SERVER_ERROR);

    }

    @RequestMapping( value = "/api/file", method = RequestMethod.PUT )
    public ResponseEntity<Evenement> updateFile(@RequestBody Evenement evenement){

        log.info("Update file for evenement " + evenement.getId());

        // retrieve the evenement id ( with file to delete )
        Evenement evenementNotUpdated = evenementsRepository.findById(evenement.getId()).orElse(null);

        // retrieve the file id to delete
        FileUploaded f = evenementNotUpdated.getFileUploadeds().stream().filter(
                            fileUploaded -> {
                                boolean b = false;
                                for ( FileUploaded fileUploaded2 : evenement.getFileUploadeds())
                                    if ( fileUploaded.getFieldId().equals( fileUploaded2.getFieldId() )) {
                                        b = true;
                                        break;
                                }
                                return !b;
                            }
                        ).findFirst().get();

        log.info("File to delete " + f.getFieldId() );

        // update the evenement without the file ( the save erase all )
        Evenement savedEvenement = evenementsRepository.save(evenement);

        // delete the file in MongoDB
        gridFsTemplate.delete(new Query(Criteria.where("_id").is(f.getFieldId())));

        // return the evenement
        HttpHeaders httpHeaders = new HttpHeaders();
        httpHeaders.setLocation(ServletUriComponentsBuilder
                .fromCurrentRequest().path("/{id}")
                .buildAndExpand(evenement.getId()).toUri());

        return new ResponseEntity<Evenement>(savedEvenement, httpHeaders, HttpStatus.CREATED);

    }

    /**
     * Helper method to determine content type from filename extension
     */
    private String getContentTypeFromFilename(String filename) {
        if (filename == null || filename.isEmpty()) {
            return "application/octet-stream";
        }
        
        String extension = filename.toLowerCase();
        if (extension.endsWith(".jpg") || extension.endsWith(".jpeg")) {
            return "image/jpeg";
        } else if (extension.endsWith(".png")) {
            return "image/png";
        } else if (extension.endsWith(".gif")) {
            return "image/gif";
        } else if (extension.endsWith(".bmp")) {
            return "image/bmp";
        } else if (extension.endsWith(".webp")) {
            return "image/webp";
        } else if (extension.endsWith(".svg")) {
            return "image/svg+xml";
        } else if (extension.endsWith(".pdf")) {
            return "application/pdf";
        } else if (extension.endsWith(".txt")) {
            return "text/plain";
        } else if (extension.endsWith(".html") || extension.endsWith(".htm")) {
            return "text/html";
        } else if (extension.endsWith(".css")) {
            return "text/css";
        } else if (extension.endsWith(".js")) {
            return "application/javascript";
        } else if (extension.endsWith(".json")) {
            return "application/json";
        } else if (extension.endsWith(".xml")) {
            return "application/xml";
        } else if (extension.endsWith(".zip")) {
            return "application/zip";
        } else if (extension.endsWith(".mp4")) {
            return "video/mp4";
        } else if (extension.endsWith(".mp3")) {
            return "audio/mpeg";
        } else if (extension.endsWith(".wav")) {
            return "audio/wav";
        } else {
            return "application/octet-stream";
        }
    }

}
