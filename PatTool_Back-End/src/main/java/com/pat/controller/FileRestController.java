package com.pat.controller;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mongodb.BasicDBObject;
import com.mongodb.DBObject;
import com.mongodb.client.gridfs.model.GridFSFile;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.FileUploaded;
import com.pat.repo.domain.Member;
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
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import java.util.concurrent.TimeUnit;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import com.drew.imaging.ImageMetadataReader;
import com.drew.imaging.ImageProcessingException;
import com.drew.metadata.Metadata;
import com.drew.metadata.MetadataException;
import com.drew.metadata.exif.ExifIFD0Directory;




/**
 * Created by patricou on 5/8/2017.
 */
@RestController
public class FileRestController {

    @Value("${app.uploaddir:C:\\temp}")
    private String uploadDir;
    
    @Value("${app.imagemaxsizekb:500}")
    private int imagemaxsizekb;
    
    @Autowired
    private EvenementsRepository evenementsRepository;
    @Autowired
    private MembersRepository membersRepository;
    @Autowired
    private GridFsTemplate gridFsTemplate;
    @Autowired
    private MailController mailController;

    private static final Logger log = LoggerFactory.getLogger(FileRestController.class);
    
    // In-memory storage for upload session logs (thread-safe)
    private final Map<String, List<String>> uploadLogs = new ConcurrentHashMap<>();

    @RequestMapping( value = "/api/file/test", method = RequestMethod.GET )
    public ResponseEntity<String> testFileEndpoint(){
        
        log.debug("Testing file endpoint configuration");
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null - MongoDB GridFS not configured");
            }
            
            return ResponseEntity.ok("GridFsTemplate is available - MongoDB GridFS configured");
        } catch (Exception e) {
            log.debug("Error testing file endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }
    
    /**
     * Get upload logs (REST endpoint for polling)
     */
    @GetMapping(value = "/api/file/upload-logs/{sessionId}")
    public ResponseEntity<List<String>> getUploadLogs(@PathVariable String sessionId) {
        List<String> logs = uploadLogs.getOrDefault(sessionId, Collections.emptyList());
        return ResponseEntity.ok()
            .header(HttpHeaders.CACHE_CONTROL, "no-cache, no-store, must-revalidate")
            .header(HttpHeaders.PRAGMA, "no-cache")
            .header(HttpHeaders.EXPIRES, "0")
            .body(logs);
    }
    
    /**
     * Helper method to add log to session
     */
    private void addUploadLog(String sessionId, String message) {
        uploadLogs.computeIfAbsent(sessionId, k -> Collections.synchronizedList(new ArrayList<>()))
                  .add(message);
    }
    
    /**
     * Clear logs for a session
     */
    private void clearUploadLogs(String sessionId) {
        uploadLogs.remove(sessionId);
    }

    @RequestMapping( value = "/api/file/debug/{fileId}", method = RequestMethod.GET )
    public ResponseEntity<String> debugFileEndpoint(@PathVariable String fileId){
        
        log.debug("Debug file endpoint for ID: " + fileId);
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null");
            }
            
            // Validate ObjectId format
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
                log.debug("ObjectId validation passed: " + objectId);
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
            log.debug("Error in debug endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/list", method = RequestMethod.GET )
    public ResponseEntity<String> listFilesEndpoint(){
        
        log.debug("List files endpoint");
        
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
            log.debug("Error in list endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/search/{fileId}", method = RequestMethod.GET )
    public ResponseEntity<String> searchFileEndpoint(@PathVariable String fileId){
        
        log.debug("Search file endpoint for ID: " + fileId);
        
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
            log.debug("Error in search endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/{fileId}", method = RequestMethod.GET )
    public ResponseEntity< InputStreamResource> getFile(@PathVariable String fileId, HttpServletRequest request, HttpServletResponse response){
        
        log.debug("Attempting to retrieve file with ID: " + fileId);

        try {
            // Check if GridFsTemplate is available
            if (gridFsTemplate == null) {
                log.debug("GridFsTemplate is null - MongoDB GridFS not properly configured");
                return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("GridFS not configured".getBytes())));
            }

            // Convert string ID to ObjectId for validation
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
            } catch (IllegalArgumentException e) {
                log.debug("Invalid ObjectId format: " + fileId, e);
                return ResponseEntity.badRequest()
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("Invalid file ID format".getBytes())));
            }
            
            // Try to find the file by ObjectId using findOne
            GridFSFile gridFsFile = gridFsTemplate.findOne(new Query(Criteria.where("_id").is(objectId)));
            
            if (gridFsFile == null) {
                log.debug("File not found: " + fileId);
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
                    log.debug("No content type found for file: " + fileId + ", using fallback: " + contentType);
                }
            } catch (com.mongodb.MongoGridFSException e) {
                // Specifically handle the "No contentType data" exception
                // Try to determine content type from filename extension
                String filename = gridFsResource.getFilename();
                contentType = getContentTypeFromFilename(filename);
                log.debug("No content type metadata for file: " + fileId + " (" + filename + "), determined type: " + contentType);
            } catch (Exception e) {
                log.debug("Error getting content type for file: " + fileId + ", using fallback", e);
                contentType = "application/octet-stream";
            }
            
            headers.setContentType(MediaType.parseMediaType(contentType));
            
            // Handle filename with fallback
            String filename = gridFsResource.getFilename();
            if (filename == null || filename.isEmpty()) {
                filename = "file_" + fileId; // Fallback filename
                log.debug("No filename found for file: " + fileId + ", using fallback: " + filename);
            }
            
            log.debug("Request file " + filename);
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
                    log.debug("Could not determine content length for file: " + fileId, e);
                }
                
                // No resizing - return original image as-is
                
                // Check if client connection is still open before returning response
                // This helps prevent AsyncRequestNotUsableException when client closes connection
                if (request != null && !response.isCommitted()) {
                    try {
                        // Check if output stream is available
                        response.getOutputStream();
                    } catch (IOException e) {
                        // Connection closed by client - log at debug level and return null
                        if (e.getMessage() != null && (e.getMessage().contains("Connection reset") || 
                                                         e.getMessage().contains("Broken pipe"))) {
                            log.debug("Client closed connection before file transfer completed for file: " + fileId);
                            return null; // Connection already closed, can't send response
                        }
                        throw e; // Re-throw if it's a different IOException
                    }
                }
                
                return ResponseEntity.ok()
                        .headers(headers)
                        .body(new InputStreamResource(gridFsResource.getInputStream()));
            } catch (IOException e) {
                // Handle connection reset gracefully - this is normal when client closes modal/slideshow
                String errorMsg = e.getMessage();
                if (errorMsg != null && (errorMsg.contains("Connection reset") || 
                                         errorMsg.contains("Broken pipe") ||
                                         errorMsg.contains("Connection closed"))) {
                    log.debug("Client closed connection during file transfer for file: " + fileId);
                    return null; // Connection already closed, can't send response
                }
                
                log.debug("Error accessing file content: " + fileId, e);
                return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("Error accessing file content".getBytes())));
            }
        } catch (IllegalStateException e) {
            log.debug("File does not exist: " + fileId + " - " + e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (com.mongodb.MongoGridFSException e) {
            log.debug("GridFS error for file: " + fileId + " - " + e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new InputStreamResource(new java.io.ByteArrayInputStream(("GridFS error: " + e.getMessage()).getBytes())));
        } catch (Exception e) {
            // Check if wrapped IOException is a connection reset
            Throwable cause = e.getCause();
            if (cause instanceof IOException) {
                String causeMsg = cause.getMessage();
                if (causeMsg != null && (causeMsg.contains("Connection reset") || 
                                         causeMsg.contains("Broken pipe"))) {
                    log.debug("Client closed connection (wrapped IOException) for file: " + fileId);
                    return null; // Connection already closed
                }
            }
            
            log.debug("Error retrieving file: " + fileId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new InputStreamResource(new java.io.ByteArrayInputStream(("Error: " + e.getMessage()).getBytes())));
        }
    }

    /**
     * Get thumbnail for an image file
     * Returns a resized version (max 200x200) of the image while maintaining aspect ratio
     */
    @RequestMapping(value = "/api/file/thumbnail/{fileId}", method = RequestMethod.GET)
    public ResponseEntity<InputStreamResource> getThumbnail(@PathVariable String fileId, HttpServletRequest request, HttpServletResponse response) {
        
        log.debug("Attempting to retrieve thumbnail for file ID: " + fileId);

        try {
            // Check if GridFsTemplate is available
            if (gridFsTemplate == null) {
                log.debug("GridFsTemplate is null - MongoDB GridFS not properly configured");
                return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("GridFS not configured".getBytes())));
            }

            // Convert string ID to ObjectId for validation
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
            } catch (IllegalArgumentException e) {
                log.debug("Invalid ObjectId format: " + fileId, e);
                return ResponseEntity.badRequest()
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("Invalid file ID format".getBytes())));
            }
            
            // Try to find the file by ObjectId using findOne
            GridFSFile gridFsFile = gridFsTemplate.findOne(new Query(Criteria.where("_id").is(objectId)));
            
            if (gridFsFile == null) {
                log.debug("File not found: " + fileId);
                return ResponseEntity.notFound().build();
            }
            
            // Get the resource from the found file
            GridFsResource gridFsResource = gridFsTemplate.getResource(gridFsFile);

            // Determine content type
            String contentType;
            try {
                contentType = gridFsResource.getContentType();
                if (contentType == null || contentType.isEmpty()) {
                    String filename = gridFsResource.getFilename();
                    contentType = getContentTypeFromFilename(filename);
                    log.debug("No content type found for file: " + fileId + ", determined from filename: " + contentType);
                }
            } catch (com.mongodb.MongoGridFSException e) {
                String filename = gridFsResource.getFilename();
                contentType = getContentTypeFromFilename(filename);
                log.debug("No content type metadata for file: " + fileId + " (" + filename + "), determined type: " + contentType);
            } catch (Exception e) {
                log.debug("Error getting content type for file: " + fileId + ", using fallback", e);
                contentType = "application/octet-stream";
            }
            
            // Check if it's an image
            if (!isImageType(contentType)) {
                log.debug("File is not an image: " + fileId + " (contentType: " + contentType + ")");
                return ResponseEntity.badRequest()
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("File is not an image".getBytes())));
            }
            
            // Read the image
            BufferedImage originalImage;
            byte[] originalFileBytes;
            try {
                // Read all bytes from input stream
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] data = new byte[8192];
                int nRead;
                java.io.InputStream inputStream = gridFsResource.getInputStream();
                while ((nRead = inputStream.read(data, 0, data.length)) != -1) {
                    buffer.write(data, 0, nRead);
                }
                originalFileBytes = buffer.toByteArray();
                originalImage = ImageIO.read(new ByteArrayInputStream(originalFileBytes));
                
                if (originalImage == null) {
                    log.debug("Could not read image from file: " + fileId);
                    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                        .body(new InputStreamResource(new java.io.ByteArrayInputStream("Could not read image".getBytes())));
                }
            } catch (IOException e) {
                log.debug("Error reading image file: " + fileId, e);
                return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("Error reading image".getBytes())));
            }
            
            // Apply EXIF orientation
            BufferedImage imageWithOrientation = applyOrientation(originalImage, originalFileBytes);
            
            // Create thumbnail (max 200x200, maintaining aspect ratio)
            BufferedImage thumbnail = createThumbnail(imageWithOrientation, 200, 200);
            
            // Convert thumbnail to byte array
            byte[] thumbnailBytes;
            try {
                thumbnailBytes = imageToByteArray(thumbnail, contentType);
            } catch (IOException e) {
                log.debug("Error converting thumbnail to bytes: " + fileId, e);
                return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("Error creating thumbnail".getBytes())));
            }
            
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.parseMediaType(contentType));
            headers.set("Content-Length", Long.toString(thumbnailBytes.length));
            headers.setCacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS).cachePublic().getHeaderValue());
            
            return ResponseEntity.ok()
                    .headers(headers)
                    .body(new InputStreamResource(new ByteArrayInputStream(thumbnailBytes)));
                    
        } catch (IllegalStateException e) {
            log.debug("File does not exist: " + fileId + " - " + e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (com.mongodb.MongoGridFSException e) {
            log.debug("GridFS error for file: " + fileId + " - " + e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new InputStreamResource(new java.io.ByteArrayInputStream(("GridFS error: " + e.getMessage()).getBytes())));
        } catch (Exception e) {
            log.debug("Error retrieving thumbnail: " + fileId, e);
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
        log.debug("Dir : " +dir);


        for (MultipartFile file : files) {

                if (!file.isEmpty()) {
                    try {
                        
                        String contentType = file.getContentType();
                        long fileSize = file.getSize();
                        long maxSizeInBytes = imagemaxsizekb * 1024L; // Convert KB to bytes
                        
                        byte[] fileBytesToWrite;
                        
                        // Check if file is an image and if it needs compression
                        if (isImageType(contentType) && fileSize > maxSizeInBytes) {
                            log.debug("Image too large for disk upload: {} bytes, compressing...", fileSize);
                            
                            try {
                                // Read entire file into byte array
                                byte[] fileBytes = file.getBytes();
                                
                                // Read the image from bytes
                                BufferedImage originalImage = ImageIO.read(new ByteArrayInputStream(fileBytes));
                                if (originalImage != null) {
                                    // Compress the image
                                    byte[] compressedBytes = resizeImageIfNeeded(
                                        file.getOriginalFilename(), 
                                        originalImage, 
                                        contentType, 
                                        fileSize, 
                                        maxSizeInBytes,
                                        fileBytes,
                                        null // No sessionId for disk uploads
                                    );
                                    fileBytesToWrite = compressedBytes;
                                    log.debug("Image compressed from {} to {} bytes", fileSize, compressedBytes.length);
                                } else {
                                    // ImageIO couldn't read it, use original bytes
                                    fileBytesToWrite = fileBytes;
                                    log.debug("Could not read image with ImageIO, using original");
                                }
                            } catch (Exception e) {
                                log.debug("Error compressing image: {}, using original", e.getMessage());
                                fileBytesToWrite = file.getBytes();
                            }
                        } else {
                            // Use original file
                            fileBytesToWrite = file.getBytes();
                        }

                        Path uploadPath = Paths.get(dir);

                        if (!Files.exists(uploadPath)) {
                            Files.createDirectories(uploadPath);
                        }

                        Path filePath = uploadPath.resolve(file.getOriginalFilename());
                        Files.write(filePath, fileBytesToWrite);

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
                                    log.debug("Issue to Unwrap user : " + je.getMessage());
                                }
                            }

                            if (! "authorization".equals(headerName.toString()) )
                                body = body + "\n" + headerName + " : "+ headerValue;
                        }

                        mailController.sendMailWithAttachement(subject,body,filePath.toString());


                    } catch (IOException e) {
                        log.debug("File Exception : " + e.getMessage());
                        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body("File Upload error : " + e.getMessage());
                    }
                }
            }
        return ResponseEntity.ok("Upload successful");
    }

    @RequestMapping( value = "/uploadfile/{userId}/{evenementid}", method = RequestMethod.POST, consumes = "multipart/form-data")
    // Important note : the name associate with RequestParam is 'file' --> seen in the browser network request.
    public ResponseEntity<List<FileUploaded>> postFile(@RequestParam("file") MultipartFile[] files, 
                                                        @RequestParam(value = "sessionId", required = false) String sessionId,
                                                        @PathVariable String userId, 
                                                        @PathVariable String evenementid  ){
        // Clean sessionId if it contains duplicates (comma-separated)
        String cleanSessionId = sessionId;
        if (sessionId != null && sessionId.contains(",")) {
            cleanSessionId = sessionId.split(",")[0].trim();
        }
        
        // Make a final variable for use in lambdas
        final String finalSessionId = cleanSessionId;
        
        // Initialize session logs if sessionId provided
        if (finalSessionId != null && !finalSessionId.isEmpty()) {
            uploadLogs.computeIfAbsent(finalSessionId, k -> Collections.synchronizedList(new ArrayList<>()));
            addUploadLog(finalSessionId, String.format("📤 Processing %d file(s)", files.length));
        }
        
        // Use finalSessionId throughout the rest of the method
        sessionId = finalSessionId;

        List<FileUploaded> uploadedFiles = new ArrayList<>();
        
        try {
            Member uploaderMember = membersRepository.findById(userId).orElse(null);
            if (uploaderMember == null) {
                log.debug("User not found: " + userId);
                return new ResponseEntity<>(null, null, HttpStatus.BAD_REQUEST);
            }

            // Find the evenement
            Evenement evenement = evenementsRepository.findById(evenementid).orElse(null);
            if (evenement == null) {
                log.debug("Evenement not found: " + evenementid);
                return new ResponseEntity<>(null, null, HttpStatus.BAD_REQUEST);
            }

            // Process each file
            for (int fileIndex = 0; fileIndex < files.length; fileIndex++) {
                MultipartFile filedata = files[fileIndex];
                if (filedata.isEmpty()) {
                    log.debug("Skipping empty file");
                    continue;
                }

                if (finalSessionId != null) {
                    addUploadLog(finalSessionId, String.format("📄 Processing file %d/%d: %s (%d KB)", 
                        fileIndex + 1, files.length, filedata.getOriginalFilename(), filedata.getSize() / 1024));
                }

                DBObject metaData = new BasicDBObject();
                metaData.put("UploaderName", uploaderMember.getFirstName()+" "+uploaderMember.getLastName());
                metaData.put("UploaderId", uploaderMember.getId());

                // Check if file is an image
                String contentType = filedata.getContentType();
                long fileSize = filedata.getSize();
                long maxSizeInBytes = imagemaxsizekb * 1024L; // Convert KB to bytes
                
                java.io.InputStream inputStream;
                
                // Check if file is an image and if it needs compression
                if (isImageType(contentType) && fileSize > maxSizeInBytes) {
                    if (sessionId != null) {
                        addUploadLog(sessionId, String.format("⚙️ Image too large (%d KB > %d KB) - Compression in progress...", 
                            fileSize / 1024, maxSizeInBytes / 1024));
                    }
                    
                    try {
                        // Read entire file into byte array (needed for both ImageIO and fallback)
                        byte[] fileBytes = filedata.getBytes();
                        
                        // Read the image from bytes
                        BufferedImage originalImage = ImageIO.read(new ByteArrayInputStream(fileBytes));
                        if (originalImage != null) {
                            if (sessionId != null) {
                                addUploadLog(sessionId, String.format("🖼️ Starting image compression for: %s", 
                                    filedata.getOriginalFilename()));
                            }
                            
                            // Compress the image
                            byte[] compressedBytes = resizeImageIfNeeded(
                                filedata.getOriginalFilename(), 
                                originalImage, 
                                contentType, 
                                fileSize, 
                                maxSizeInBytes,
                                fileBytes,
                                sessionId
                            );
                            
                            // Create input stream from compressed bytes
                            inputStream = new ByteArrayInputStream(compressedBytes);
                            if (sessionId != null) {
                                addUploadLog(sessionId, String.format("✅ Compression completed: %d KB → %d KB", 
                                    fileSize / 1024, compressedBytes.length / 1024));
                            }
                            log.debug("Image compressed from {} to {} bytes", fileSize, compressedBytes.length);
                        } else {
                            // ImageIO couldn't read it, use original bytes
                            inputStream = new ByteArrayInputStream(fileBytes);
                            log.debug("Could not read image with ImageIO, using original");
                        }
                    } catch (Exception e) {
                        if (sessionId != null) {
                            addUploadLog(sessionId, "⚠️ Compression error, using original file");
                        }
                        log.debug("Error compressing image: {}, using original", e.getMessage());
                        inputStream = new ByteArrayInputStream(filedata.getBytes());
                    }
                } else {
                    // Use original file
                    if (sessionId != null && isImageType(contentType)) {
                        addUploadLog(sessionId, String.format("✓ Image OK, no compression needed (%d KB)", fileSize / 1024));
                    }
                    inputStream = filedata.getInputStream();
                }

                // Save the doc ( all type ) in  MongoDB
                String fieldId =
                        gridFsTemplate.store( inputStream, filedata.getOriginalFilename(), filedata.getContentType(), metaData).toString();
                log.debug("Doc created id : "+fieldId);

                // create the file info
                FileUploaded fileUploaded = new FileUploaded(fieldId, filedata.getOriginalFilename(), filedata.getContentType(), uploaderMember);
                uploadedFiles.add(fileUploaded);
                
                // Add file to evenement
                evenement.getFileUploadeds().add(fileUploaded);
            }

            // Save the evenement updated with all files
            Evenement eventSaved = evenementsRepository.save(evenement);
            log.debug("Evenement saved with " + uploadedFiles.size() + " files");

            if (finalSessionId != null) {
                addUploadLog(finalSessionId, String.format("✅ Upload completed! %d file(s) saved", uploadedFiles.size()));
                // Clean up logs after 5 seconds
                new Thread(() -> {
                    try {
                        Thread.sleep(5000);
                        clearUploadLogs(finalSessionId);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }).start();
            }

            HttpHeaders httpHeaders = new HttpHeaders();
            httpHeaders.setLocation(ServletUriComponentsBuilder
                    .fromCurrentRequest().path("/{id}")
                    .buildAndExpand(eventSaved.getId()).toUri());

            return new ResponseEntity<List<FileUploaded>>(uploadedFiles, httpHeaders, HttpStatus.CREATED);

        }catch (Exception e ){
            log.debug(" Exception error " + e);
        }

        return new ResponseEntity<>(null,null,HttpStatus.INTERNAL_SERVER_ERROR);

    }

    @RequestMapping( value = "/api/file", method = RequestMethod.PUT )
    public ResponseEntity<Evenement> updateFile(@RequestBody Evenement evenement){

        log.debug("Update file for evenement " + evenement.getId());

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

        log.debug("File to delete " + f.getFieldId() );

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

    /**
     * Check if content type is an image
     */
    private boolean isImageType(String contentType) {
        if (contentType == null) {
            return false;
        }
        return contentType.startsWith("image/");
    }

    /**
     * Apply EXIF orientation to image if needed
     */
    private BufferedImage applyOrientation(BufferedImage image, byte[] fileBytes) {
        try {
            Metadata metadata = ImageMetadataReader.readMetadata(new ByteArrayInputStream(fileBytes));
            ExifIFD0Directory exifIFD0Directory = metadata.getFirstDirectoryOfType(ExifIFD0Directory.class);
            
            if (exifIFD0Directory != null && exifIFD0Directory.containsTag(ExifIFD0Directory.TAG_ORIENTATION)) {
                int orientation = exifIFD0Directory.getInt(ExifIFD0Directory.TAG_ORIENTATION);
                log.debug("Image EXIF orientation: {}", orientation);
                
                // Apply rotation based on EXIF orientation
                switch (orientation) {
                    case 3: // 180 degrees
                        return rotateImage(image, 180);
                    case 6: // 90 degrees CW
                        return rotateImage(image, 90);
                    case 8: // 90 degrees CCW
                        return rotateImage(image, -90);
                    case 2: // Flip horizontal
                    case 4: // Flip vertical
                    case 5: // Flip horizontal + 90 CW
                    case 7: // Flip horizontal + 90 CCW
                        log.debug("Flip operations not fully supported, returning as-is");
                        break;
                    default:
                        log.debug("No rotation needed (orientation: {})", orientation);
                        break;
                }
            }
        } catch (ImageProcessingException | MetadataException | IOException e) {
            log.debug("Could not read EXIF metadata: {}", e.getMessage());
        }
        
        return image;
    }
    
    /**
     * Rotate image by specified angle
     */
    private BufferedImage rotateImage(BufferedImage image, double angle) {
        int width = image.getWidth();
        int height = image.getHeight();
        int type = image.getType();
        
        // Calculate new dimensions for rotation
        double radians = Math.toRadians(angle);
        double cos = Math.abs(Math.cos(radians));
        double sin = Math.abs(Math.sin(radians));
        int newWidth = (int) Math.round(width * cos + height * sin);
        int newHeight = (int) Math.round(height * cos + width * sin);
        
        BufferedImage rotated = new BufferedImage(newWidth, newHeight, type);
        Graphics2D g = rotated.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        
        // Translate and rotate
        int offsetX = (newWidth - width) / 2;
        int offsetY = (newHeight - height) / 2;
        g.translate(offsetX, offsetY);
        g.rotate(radians, width / 2.0, height / 2.0);
        g.drawImage(image, 0, 0, null);
        g.dispose();
        
        log.debug("Rotated image by {} degrees", angle);
        return rotated;
    }

    /**
     * Compress and resize image to MEET max size requirement
     * Aggressively reduces size until absolutely under limit
     */
    private byte[] resizeImageIfNeeded(String filename, BufferedImage originalImage, String contentType, long originalSize, long maxSize, byte[] originalFileBytes, String sessionId) throws IOException {
        int originalWidth = originalImage.getWidth();
        int originalHeight = originalImage.getHeight();
        if (sessionId != null) {
            addUploadLog(sessionId, String.format("📏 Original image: %dx%d, %d KB", 
                originalWidth, originalHeight, originalSize / 1024));
        }
        
        // Apply EXIF orientation
        BufferedImage imageWithOrientation = applyOrientation(originalImage, originalFileBytes);
        
        // Convert to RGB
        BufferedImage imageToCompress;
        if (imageWithOrientation.getType() == BufferedImage.TYPE_INT_RGB || 
            imageWithOrientation.getType() == BufferedImage.TYPE_INT_ARGB) {
            imageToCompress = imageWithOrientation;
        } else {
            int width = imageWithOrientation.getWidth();
            int height = imageWithOrientation.getHeight();
            imageToCompress = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            Graphics2D g = imageToCompress.createGraphics();
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.drawImage(imageWithOrientation, 0, 0, null);
            g.dispose();
        }
        
        String format = contentType.contains("png") ? "png" : "jpeg";
        
        // Try minimal compression first
        byte[] result = compressWithQuality(imageToCompress, format, 0.5f);
        
        if (sessionId != null) {
            addUploadLog(sessionId, String.format("📊 Size after compression: %d KB", result.length / 1024));
        }
        
        // If already under limit, return
        if (result.length <= maxSize) {
            if (sessionId != null) {
                addUploadLog(sessionId, String.format("✅ Final size: %d KB (no resize needed)", 
                    result.length / 1024));
            }
            return result;
        }
        
        // Need to resize - calculate aggressive reduction
        // IMPORTANT: Use dimensions from imageToCompress (after EXIF orientation), not originalImage
        int imageToCompressWidth = imageToCompress.getWidth();
        int imageToCompressHeight = imageToCompress.getHeight();
        
        if (sessionId != null) {
            addUploadLog(sessionId, String.format("📐 Starting resize: %dx%d, current size: %d KB", 
                imageToCompressWidth, imageToCompressHeight, result.length / 1024));
        }
        
        // Calculate aspect ratio to maintain proportions
        double aspectRatio = (double) imageToCompressWidth / imageToCompressHeight;
        
        int currentWidth = imageToCompressWidth;
        int currentHeight = imageToCompressHeight;
        int attempt = 0;
        
        // Keep resizing until we get under maxSize (GUARANTEED to finish under limit)
        while (result.length > maxSize && attempt < 10) {
            attempt++;
            
            // Calculate scaling factor based on current size vs max
            double sizeRatio = (double) maxSize / result.length;
            double scaleFactor = Math.sqrt(sizeRatio) * 0.8; // 0.8 for very aggressive reduction
            
            // Apply scale factor while maintaining aspect ratio
            currentWidth = (int) (currentWidth * scaleFactor);
            currentHeight = (int) (currentHeight * scaleFactor);
            
            // Ensure we maintain the aspect ratio by recalculating if needed
            double currentAspectRatio = (double) currentWidth / currentHeight;
            if (Math.abs(currentAspectRatio - aspectRatio) > 0.01) {
                // Recalculate to maintain exact aspect ratio
                if (currentAspectRatio > aspectRatio) {
                    // Width is too large, adjust based on height
                    currentWidth = (int) (currentHeight * aspectRatio);
                } else {
                    // Height is too large, adjust based on width
                    currentHeight = (int) (currentWidth / aspectRatio);
                }
            }
            
            // Minimum size check - maintain aspect ratio
            if (currentWidth < 150 || currentHeight < 150) {
                if (aspectRatio >= 1.0) {
                    // Landscape or square
                    currentWidth = Math.max(150, currentWidth);
                    currentHeight = (int) (currentWidth / aspectRatio);
                } else {
                    // Portrait
                    currentHeight = Math.max(150, currentHeight);
                    currentWidth = (int) (currentHeight * aspectRatio);
                }
            }
            
            if (sessionId != null && attempt == 1) {
                addUploadLog(sessionId, String.format("🔄 Resizing to %dx%d", 
                    currentWidth, currentHeight));
            }
            
            // Resize
            BufferedImage resizedImage = new BufferedImage(currentWidth, currentHeight, BufferedImage.TYPE_INT_RGB);
            Graphics2D g = resizedImage.createGraphics();
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.drawImage(imageToCompress, 0, 0, currentWidth, currentHeight, null);
            g.dispose();
            
            // Try different quality levels in sequence
            float[] qualities = {0.4f, 0.3f, 0.2f};
            
            for (float quality : qualities) {
                result = compressWithQuality(resizedImage, format, quality);
                
                if (sessionId != null && result.length <= maxSize) {
                    addUploadLog(sessionId, String.format("📊 Size after resize %dx%d: %d KB", 
                        currentWidth, currentHeight, result.length / 1024));
                }
                
                if (result.length <= maxSize) {
                    if (sessionId != null) {
                        addUploadLog(sessionId, String.format("✅ Final size: %d KB (%dx%d)", 
                            result.length / 1024, currentWidth, currentHeight));
                    }
                    return result;
                }
            }
            
            imageToCompress = resizedImage;
        }
        
        // Final attempt - if still over limit, use minimal quality
        if (result.length > maxSize) {
            float quality = 0.15f;
            result = compressWithQuality(imageToCompress, format, quality);
            
            // If STILL over limit, we need to reduce dimensions even more
            // Maintain aspect ratio during reduction
            while (result.length > maxSize && currentWidth > 100 && currentHeight > 100) {
                double reductionFactor = 0.9;
                currentWidth = (int) (currentWidth * reductionFactor);
                currentHeight = (int) (currentHeight * reductionFactor);
                
                // Ensure aspect ratio is maintained
                double currentAspectRatio = (double) currentWidth / currentHeight;
                if (Math.abs(currentAspectRatio - aspectRatio) > 0.01) {
                    if (currentAspectRatio > aspectRatio) {
                        currentWidth = (int) (currentHeight * aspectRatio);
                    } else {
                        currentHeight = (int) (currentWidth / aspectRatio);
                    }
                }
                
                BufferedImage finalResize = new BufferedImage(currentWidth, currentHeight, BufferedImage.TYPE_INT_RGB);
                Graphics2D g = finalResize.createGraphics();
                g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                g.drawImage(imageToCompress, 0, 0, currentWidth, currentHeight, null);
                g.dispose();
                
                result = compressWithQuality(finalResize, format, quality);
            }
        }
        
        if (sessionId != null) {
            addUploadLog(sessionId, String.format("✅ Final size: %d KB (%dx%d)", 
                result.length / 1024, currentWidth, currentHeight));
        }
        
        return result;
    }
    
    /**
     * Compress image with specific quality
     */
    private byte[] compressWithQuality(BufferedImage image, String format, float quality) throws IOException {
        ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
        
        if (format.equals("jpeg")) {
            javax.imageio.ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
            javax.imageio.plugins.jpeg.JPEGImageWriteParam params = new javax.imageio.plugins.jpeg.JPEGImageWriteParam(null);
            params.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT);
            params.setCompressionQuality(quality);
            
            javax.imageio.stream.ImageOutputStream imageOutputStream = ImageIO.createImageOutputStream(outputStream);
            writer.setOutput(imageOutputStream);
            writer.write(null, new javax.imageio.IIOImage(image, null, null), params);
            writer.dispose();
        } else {
            ImageIO.write(image, format, outputStream);
        }
        
        return outputStream.toByteArray();
    }

    /**
     * Create a thumbnail from an image while maintaining aspect ratio
     * @param originalImage The original image
     * @param maxWidth Maximum width for the thumbnail
     * @param maxHeight Maximum height for the thumbnail
     * @return The thumbnail image
     */
    private BufferedImage createThumbnail(BufferedImage originalImage, int maxWidth, int maxHeight) {
        int originalWidth = originalImage.getWidth();
        int originalHeight = originalImage.getHeight();
        
        // Calculate new dimensions maintaining aspect ratio
        double aspectRatio = (double) originalWidth / originalHeight;
        int newWidth, newHeight;
        
        if (originalWidth > originalHeight) {
            // Landscape or square
            newWidth = Math.min(originalWidth, maxWidth);
            newHeight = (int) (newWidth / aspectRatio);
            if (newHeight > maxHeight) {
                newHeight = maxHeight;
                newWidth = (int) (newHeight * aspectRatio);
            }
        } else {
            // Portrait
            newHeight = Math.min(originalHeight, maxHeight);
            newWidth = (int) (newHeight * aspectRatio);
            if (newWidth > maxWidth) {
                newWidth = maxWidth;
                newHeight = (int) (newWidth / aspectRatio);
            }
        }
        
        // If image is already smaller than thumbnail size, return original
        if (originalWidth <= maxWidth && originalHeight <= maxHeight) {
            return originalImage;
        }
        
        // Create resized image
        BufferedImage thumbnail = new BufferedImage(newWidth, newHeight, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = thumbnail.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.drawImage(originalImage, 0, 0, newWidth, newHeight, null);
        g.dispose();
        
        return thumbnail;
    }

    /**
     * Convert BufferedImage to byte array
     * @param image The image to convert
     * @param contentType The content type (determines format)
     * @return The image as byte array
     * @throws IOException If conversion fails
     */
    private byte[] imageToByteArray(BufferedImage image, String contentType) throws IOException {
        ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
        
        String format = "jpeg"; // Default format
        if (contentType != null) {
            if (contentType.contains("png")) {
                format = "png";
            } else if (contentType.contains("gif")) {
                format = "gif";
            } else if (contentType.contains("bmp")) {
                format = "bmp";
            } else if (contentType.contains("webp")) {
                format = "webp";
            }
        }
        
        if (format.equals("jpeg")) {
            // Convert to RGB if needed for JPEG
            BufferedImage rgbImage;
            if (image.getType() == BufferedImage.TYPE_INT_RGB || image.getType() == BufferedImage.TYPE_INT_ARGB) {
                rgbImage = image;
            } else {
                rgbImage = new BufferedImage(image.getWidth(), image.getHeight(), BufferedImage.TYPE_INT_RGB);
                Graphics2D g = rgbImage.createGraphics();
                g.drawImage(image, 0, 0, null);
                g.dispose();
            }
            
            javax.imageio.ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
            javax.imageio.plugins.jpeg.JPEGImageWriteParam params = new javax.imageio.plugins.jpeg.JPEGImageWriteParam(null);
            params.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT);
            params.setCompressionQuality(0.7f); // Optimized quality for thumbnails (smaller file size, faster loading)
            params.setOptimizeHuffmanTables(true); // Enable Huffman optimization for better compression
            javax.imageio.stream.ImageOutputStream imageOutputStream = ImageIO.createImageOutputStream(outputStream);
            writer.setOutput(imageOutputStream);
            writer.write(null, new javax.imageio.IIOImage(rgbImage, null, null), params);
            writer.dispose();
        } else {
            ImageIO.write(image, format, outputStream);
        }
        
        return outputStream.toByteArray();
    }

}
