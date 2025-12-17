package com.pat.controller;

import com.pat.repo.domain.CategoryLink;
import com.pat.repo.domain.UrlLink;
import com.pat.repo.CategoryLinkRepository;
import com.pat.repo.UrlLinkRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/categories")
public class CategoryLinkRestController {

    private static final Logger log = LoggerFactory.getLogger(CategoryLinkRestController.class);

    @Autowired
    CategoryLinkRepository categoryLinkRepository;
    
    @Autowired
    UrlLinkRepository urlLinkRepository;

    @RequestMapping(method = RequestMethod.GET)
    public List<CategoryLink> getCategory(@RequestHeader(value = "user-id", required = false) String userId){
        log.debug("Get categoryUrl for user: {}", userId);
        Sort sort = Sort.by(Sort.Direction.ASC, "categoryName");
        List<CategoryLink> allCategories = categoryLinkRepository.findAll(sort);
        
        // Filter categories: show public ones or those where user is author
        if (userId != null && !userId.isEmpty()) {
            return allCategories.stream()
                .filter(category -> {
                    // If no visibility or public, show it
                    if (category.getVisibility() == null || "public".equals(category.getVisibility())) {
                        return true;
                    }
                    // If private, only show if user is the author
                    if ("private".equals(category.getVisibility()) && category.getAuthor() != null) {
                        return userId.equals(category.getAuthor().getId());
                    }
                    return false;
                })
                .collect(Collectors.toList());
        }
        
        // If no user ID, return only public categories
        return allCategories.stream()
            .filter(category -> category.getVisibility() == null || "public".equals(category.getVisibility()))
            .collect(Collectors.toList());
    }

    @GetMapping("/{id}")
    public ResponseEntity<CategoryLink> getCategoryById(@PathVariable String id) {
        log.info("Get category by id: {}", id);
        Optional<CategoryLink> category = categoryLinkRepository.findById(id);
        return category.map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping(produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<CategoryLink> createCategory(@RequestBody CategoryLink category) {
        log.info("Create category: {}", category.getCategoryName());
        try {
            // Capitalize first letter of name
            if (category.getCategoryName() != null && !category.getCategoryName().isEmpty()) {
                String name = category.getCategoryName();
                category.setCategoryName(name.substring(0, 1).toUpperCase() + name.substring(1).toLowerCase());
            }
            
            // Capitalize first letter of description
            if (category.getCategoryDescription() != null && !category.getCategoryDescription().isEmpty()) {
                String description = category.getCategoryDescription();
                category.setCategoryDescription(description.substring(0, 1).toUpperCase() + description.substring(1).toLowerCase());
            }
            
            // Generate next categoryLinkID if needed
            if (category.getCategoryLinkID() == null || category.getCategoryLinkID().isEmpty()) {
                // Find the maximum categoryLinkID and increment by 1
                List<CategoryLink> allCategories = categoryLinkRepository.findAll();
                long maxId = 0;
                for (CategoryLink cat : allCategories) {
                    try {
                        long id = Long.parseLong(cat.getCategoryLinkID());
                        if (id > maxId) {
                            maxId = id;
                        }
                    } catch (NumberFormatException e) {
                        // Skip invalid categoryLinkID values
                    }
                }
                category.setCategoryLinkID(String.valueOf(maxId + 1));
            }
            // Don't set MongoDB _id manually, let MongoDB generate it
            category.setId(null);
            CategoryLink savedCategory = categoryLinkRepository.save(category);
            return new ResponseEntity<>(savedCategory, HttpStatus.CREATED);
        } catch (Exception e) {
            log.error("Error creating category: ", e);
            return new ResponseEntity<>(null, HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @PutMapping("/{id}")
    public ResponseEntity<CategoryLink> updateCategory(@PathVariable String id, @RequestBody CategoryLink categoryDetails) {
        log.info("Update category with id: {}", id);
        Optional<CategoryLink> categoryOptional = categoryLinkRepository.findById(id);
        
        if (categoryOptional.isPresent()) {
            CategoryLink category = categoryOptional.get();
            
            // Capitalize first letter of name if provided
            if (categoryDetails.getCategoryName() != null && !categoryDetails.getCategoryName().isEmpty()) {
                String name = categoryDetails.getCategoryName();
                category.setCategoryName(name.substring(0, 1).toUpperCase() + name.substring(1).toLowerCase());
            }
            
            // Capitalize first letter of description if provided
            if (categoryDetails.getCategoryDescription() != null && !categoryDetails.getCategoryDescription().isEmpty()) {
                String description = categoryDetails.getCategoryDescription();
                category.setCategoryDescription(description.substring(0, 1).toUpperCase() + description.substring(1).toLowerCase());
            }
            
            category.setCategoryLinkID(categoryDetails.getCategoryLinkID());
            
            // Update visibility if provided
            if (categoryDetails.getVisibility() != null && !categoryDetails.getVisibility().isEmpty()) {
                category.setVisibility(categoryDetails.getVisibility());
            }
            
            // Update author if provided
            if (categoryDetails.getAuthor() != null) {
                category.setAuthor(categoryDetails.getAuthor());
            }
            
            CategoryLink updatedCategory = categoryLinkRepository.save(category);
            return ResponseEntity.ok(updatedCategory);
        } else {
            return ResponseEntity.notFound().build();
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> deleteCategory(@PathVariable String id) {
        log.info("Delete category with id: {}", id);
        try {
            Optional<CategoryLink> categoryOptional = categoryLinkRepository.findById(id);
            
            if (!categoryOptional.isPresent()) {
                log.warn("Category not found: {}", id);
                return new ResponseEntity<>("Category not found", HttpStatus.NOT_FOUND);
            }
            
            CategoryLink category = categoryOptional.get();
            String categoryLinkID = category.getCategoryLinkID();
            
            // Check if any urllinks are associated with this category
            List<UrlLink> urllinks = urlLinkRepository.findByCategoryLinkID(categoryLinkID);
            
            if (urllinks != null && !urllinks.isEmpty()) {
                log.warn("Cannot delete category {} because it has {} associated urllinks", categoryLinkID, urllinks.size());
                return new ResponseEntity<>("Cannot delete category: it has " + urllinks.size() + " associated link(s)", HttpStatus.BAD_REQUEST);
            }
            
            // No urllinks associated, safe to delete
            categoryLinkRepository.deleteById(id);
            log.info("Category deleted successfully: {}", id);
            return new ResponseEntity<>(HttpStatus.NO_CONTENT);
        } catch (Exception e) {
            log.error("Error deleting category: ", e);
            return new ResponseEntity<>("Error deleting category: " + e.getMessage(), HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }
}
