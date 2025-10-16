package com.pat.controller;

import com.pat.domain.CategoryLink;
import com.pat.domain.Evenement;
import com.pat.domain.UrlLink;
import com.pat.repo.CategoryLinkRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/categories")
public class CategoryLinkRestController {

    private static final Logger log = LoggerFactory.getLogger(CategoryLinkRestController.class);

    @Autowired
    CategoryLinkRepository categoryLinkRepository;


    @RequestMapping(method = RequestMethod.GET)
    public List<CategoryLink> getCategory(){

        log.info("Get categoryUrl");
        Sort sort = Sort.by(Sort.Direction.ASC, "categoryName");

        return categoryLinkRepository.findAll(sort);
    }




}
