---
layout: resume_page
permalink: /resume/
title: resume
nav: true
---


<div class="container flex-parent jc-center btn-group">
    <button class="b1" onClick="myFunction()" title="Resume (2 Page)" >
        Resume (2 Page)
    </button>
    <button class="b2" onClick="myFunction2()" title="Curriculum Vitae">
        Curriculum Vitae
    </button>
</div>

<div class="flex-parent jc-center content">
    <div id="first" style="display:none;">
        <object data="\assets\pdf\K-T-Prajwal-Prathiksh--Resume--(2-Page).pdf" type="application/pdf" width="900px" height="900px">
            <embed src="\assets\pdf\K-T-Prajwal-Prathiksh--Resume--(2-Page).pdf" type="application/pdf"> 
                <p>
                    This browser does not support PDFs. Please download the PDF to view it: <a href="\assets\pdf\K-T-Prajwal-Prathiksh--Resume--(2-Page).pdf">Download PDF</a>.
                </p>
            </embed>
        </object>
    </div>
    <div id="second" style="display:none;">
        <object data="\assets\pdf\K-T-Prajwal-Prathiksh--Curriculum-Vitae.pdf" type="application/pdf" width="900px" height="900px">
            <embed src="\assets\pdf\K-T-Prajwal-Prathiksh--Curriculum-Vitae.pdf" type="application/pdf"> 
                <p>
                    This browser does not support PDFs. Please download the PDF to view it: <a href="\assets\pdf\K-T-Prajwal-Prathiksh--Curriculum-Vitae.pdf">Download PDF</a>.
                </p>
            </embed>
        </object>
    </div>
</div>

<script>
    const myFunction = () => {
        document.getElementById("first").style.display ='block';
        document.getElementById("second").style.display ='none'
    }

    const myFunction2 = () => {
        document.getElementById("second").style.display ='block'
        document.getElementById("first").style.display ='none'
    }
</script>